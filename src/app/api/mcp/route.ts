import { NextResponse } from "next/server";
import {
  chatForCapability,
  createProposal,
  MAX_PENDING_PROPOSALS,
  pendingProposals,
} from "@/lib/chat";
import { listTemplates, getTemplate } from "@/lib/templates";
import { describeFolder, listRuns, resolveWorkspaceFolder } from "@/lib/orchestrator";
import { githubRemotes, scanWorkspace } from "@/lib/workspace";
import { mountById } from "@/lib/config";
import { fmtUSD } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tool surface the orchestrator chat calls back into.
 *
 * MCP over streamable HTTP, spoken by hand rather than through the SDK: the
 * subset a `-p` child actually uses is `initialize`, `tools/list` and
 * `tools/call`, and adding a dependency to the image — which pins the CLI for
 * exactly this kind of reverse-engineered contract — buys less than it costs.
 * Responses are plain JSON rather than SSE, which the transport permits for a
 * single reply and which is all a request/response tool call needs.
 *
 * **Why these tools live in this process.** `createRun`'s folder claim is a
 * synchronous check-then-insert, atomic only because one Node event-loop turn
 * runs to completion; a stdio MCP server would be a second process doing
 * check-then-insert against the same SQLite file, which silently permits the
 * two-agents-in-one-directory collision the claim exists to prevent. See the
 * note at the top of `db.ts`.
 *
 * **Why this route authenticates itself.** `middleware.ts` runs in the edge
 * runtime and cannot reach SQLite or module state, so it cannot check a
 * per-chat credential — the path is exempted there and the check happens here.
 * The credential is *not* `UF_AUTH_TOKEN`: it is a capability minted for one
 * chat turn and revoked when that turn's child exits, so a copy of it recovered
 * afterwards opens nothing. Every tool below is scoped to the chat it names.
 *
 * Note what is absent: nothing here starts, stops, resumes or reopens a run,
 * and nothing here writes to a folder. The most a caller can do is add a row to
 * `chat_proposals`, which is inert until a person approves it.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "list_folders",
    description:
      "List every workspace mount and the project folders in it, with which " +
      "runs are already working there and, for git repositories, the GitHub " +
      "repo they point at. Folder paths for propose_run must come from here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_templates",
    description:
      "List saved run templates. A template supplies every guard a proposed " +
      "run will start under — budget, work-cycle limit, permission mode, " +
      "isolation. Proposals must name one of these by id.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_runs",
    description:
      "List recent runs with their status, folder and spend, so work already " +
      "in flight is not proposed a second time.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many to return (default 20)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "propose_run",
    description:
      "Propose one run for the operator to approve. This does NOT start " +
      "anything: it records a proposal that a person approves or rejects by " +
      "hand. Guards come from the template and cannot be set here.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          description: "id from list_templates. Supplies every guard.",
        },
        title: {
          type: "string",
          description: "Short specific label, e.g. 'Fix #412 flaky auth test'.",
        },
        task: {
          type: "string",
          description:
            "The full brief for the agent: what to do, the issue number and " +
            "URL if there is one, and what done looks like.",
        },
        mountId: {
          type: "string",
          description:
            "Mount from list_folders. Omit to use the template's own folder.",
        },
        folder: {
          type: "string",
          description:
            "Path within the mount, exactly as list_folders gives it. Required " +
            "when mountId is given; \"\" means the mount root.",
        },
      },
      required: ["templateId", "title", "task"],
      additionalProperties: false,
    },
  },
];

export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const chatId = chatForCapability(bearer);
  if (!chatId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // A batch is legal on the wire even though the CLI does not send one.
  const batch = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of batch) {
    const reply = await handle(msg, chatId);
    if (reply) replies.push(reply);
  }

  // Every message was a notification. 202 with no body is what the transport
  // asks for, and answering `{}` instead makes some clients wait for a result
  // that is never coming.
  if (replies.length === 0) return new Response(null, { status: 202 });

  return NextResponse.json(Array.isArray(body) ? replies : replies[0]);
}

/** The transport's other verbs. Neither is needed: there is no server stream. */
export async function GET() {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32601, message: "No server stream" } },
    { status: 405 },
  );
}

export async function DELETE() {
  return new Response(null, { status: 405 });
}

async function handle(
  msg: JsonRpcRequest,
  chatId: string,
): Promise<object | null> {
  const id = msg.id ?? null;
  const method = String(msg.method ?? "");

  // A notification has no id and takes no reply, whatever it asks for —
  // `notifications/initialized` is the one the CLI actually sends.
  if (msg.id === undefined || msg.id === null) return null;

  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (method) {
    case "initialize": {
      // Echo a protocol version the client asked for when we recognise its
      // shape, rather than insisting on ours: this file speaks a subset that
      // has not changed across these revisions, and refusing a newer client
      // over a version string would break the feature on a CLI bump.
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "usagefoundry", version: "0.1.0" },
      });
    }

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: TOOLS });

    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(await callTool(name, args, chatId));
      } catch (err) {
        // A tool that throws is reported as tool output, not as a protocol
        // error: the model can read and act on the former and only sees a
        // dropped turn from the latter.
        return ok(text(`Error: ${err instanceof Error ? err.message : String(err)}`, true));
      }
    }

    default:
      return fail(-32601, `Unknown method: ${method}`);
  }
}

function text(body: string, isError = false) {
  return { content: [{ type: "text", text: body }], isError };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
) {
  switch (name) {
    case "list_folders": {
      const { mounts, folders } = await scanWorkspace();
      const { repos, notRead } = await githubRemotes(folders);
      return text(
        JSON.stringify(
          {
            mounts: mounts.map((m) => ({
              mountId: m.id,
              label: m.label,
              available: m.available,
              error: m.error,
              truncated: m.truncated,
            })),
            folders: folders.map((f) => ({
              mountId: f.mountId,
              folder: f.path,
              isGitRepo: f.isGitRepo,
              repo: repos[`${f.mountId}:${f.path}`] ?? null,
              busyRunId: f.busyRunId,
              parkedRunId: f.parkedRunId,
              queuedCount: f.queuedCount,
            })),
            // Said rather than left to be inferred, for the reason a shortened
            // diff says so: a missing `repo` that means "not looked at" and one
            // that means "not GitHub" are different sentences.
            repoLookupsSkipped: notRead,
          },
          null,
          1,
        ),
      );
    }

    case "list_templates": {
      const templates = listTemplates();
      if (templates.length === 0) {
        return text(
          "There are no run templates. A proposal must name one, because a " +
            "template is where a run's budget, work-cycle limit and permission " +
            "mode come from. Tell the operator to create one on the Settings " +
            "page before you can propose anything.",
        );
      }
      return text(
        JSON.stringify(
          templates.map((t) => ({
            templateId: t.id,
            name: t.name,
            prompt: t.prompt,
            mountId: t.mountId,
            folder: t.folder,
            isolate: t.isolate,
            permissionMode: t.permissionMode,
            budget: t.budget,
          })),
          null,
          1,
        ),
      );
    }

    case "list_runs": {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      return text(
        JSON.stringify(
          listRuns(limit).map((r) => {
            const { mountId, relPath } = describeFolder(r.folder);
            return {
              runId: r.id,
              status: r.status,
              mountId,
              folder: relPath,
              branch: r.worktree_branch,
              iterations: r.iterations,
              spent: fmtUSD(r.spent_usd),
              stopReason: r.stop_reason,
              task: r.prompt.slice(0, 200),
            };
          }),
          null,
          1,
        ),
      );
    }

    case "propose_run":
      return proposeRun(args, chatId);

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

/**
 * Record one proposal, refusing anything that could not later be approved.
 *
 * Deliberately stricter than it has to be. `planProposal` and `createRun` both
 * check these again at approval time and only those checks guard anything —
 * but a proposal that cannot be approved is discovered by a person clicking
 * Approve on a list of twenty, which is the wrong moment and the wrong person.
 * The same reasoning `normalizeTemplateInput` gives for validating at the form.
 */
function proposeRun(args: Record<string, unknown>, chatId: string) {
  const templateId = String(args.templateId ?? "").trim();
  const template = templateId ? getTemplate(templateId) : null;
  if (!template) {
    return text(
      `No template with id "${templateId}". Call list_templates and use an id from it.`,
      true,
    );
  }

  const title = String(args.title ?? "").trim();
  if (!title) return text("A proposal needs a title.", true);

  const task = String(args.task ?? "").trim();
  if (!task) {
    return text(
      "A proposal needs a task. It is the whole brief the agent gets besides " +
        "the template's own prompt.",
      true,
    );
  }

  // Null means "whatever the template says". "" is a real answer — the mount
  // root — so the two are never collapsed. See the same note in planProposal.
  const hasMount = args.mountId !== undefined && args.mountId !== null && args.mountId !== "";
  let mountId: string | null = null;
  let folder: string | null = null;

  if (hasMount) {
    mountId = String(args.mountId);
    if (!mountById(mountId)) {
      return text(
        `No workspace mount called "${mountId}". Call list_folders for the ids.`,
        true,
      );
    }
    folder = String(args.folder ?? "");
    try {
      resolveWorkspaceFolder(folder, mountId);
    } catch (err) {
      return text(
        `That folder cannot be used: ${err instanceof Error ? err.message : String(err)}. ` +
          "Use a folder exactly as list_folders gives it.",
        true,
      );
    }
  } else if (template.mountId === null) {
    return text(
      `The "${template.name}" template does not name a folder, so this ` +
        "proposal has to. Pass mountId and folder from list_folders.",
      true,
    );
  }

  const pending = pendingProposals(chatId);
  if (pending.length >= MAX_PENDING_PROPOSALS) {
    return text(
      `This chat already has ${pending.length} proposals waiting for approval, ` +
        `which is the limit (${MAX_PENDING_PROPOSALS}). A list that long stops ` +
        "getting read before it gets approved. Tell the operator what you would " +
        "propose next and ask them to approve or reject these first, or narrow " +
        "what you are proposing.",
      true,
    );
  }

  const proposal = createProposal(chatId, { templateId, title, task, mountId, folder });
  return text(
    `Proposed "${title}" (id ${proposal.id}) against template "${template.name}". ` +
      "It is waiting for the operator to approve it; nothing is running.",
  );
}

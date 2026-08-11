import {
  listMessages,
  listProposals,
  type ChatRow,
} from "@/lib/chat";
import { getTemplate } from "@/lib/templates";
import { chatGuards } from "@/lib/settings";
import { mountById } from "@/lib/config";
import { fmtUSD } from "@/lib/format";
import type { ChatDTO, ChatProposalDTO } from "@/lib/apiTypes";

/**
 * A chat as the page reads it.
 *
 * Shared by the list route and the single-chat route so the two cannot answer
 * differently about the same thread. Resolving the template *name* here rather
 * than on the client is what lets the card say "the template this was proposed
 * against is gone" — a null name is the same fact `planProposal` refuses on,
 * shown before the operator clicks rather than after.
 */
export function chatDTO(chat: ChatRow): ChatDTO {
  return {
    id: chat.id,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    title: chat.title,
    status: chat.status,
    costUSD: chat.cost_usd,
    tokens: chat.tokens,
    error: chat.error,
    messages: listMessages(chat.id).map((m) => ({
      id: m.id,
      ts: m.ts,
      role: m.role,
      text: m.text,
    })),
    proposals: listProposals(chat.id).map(proposalDTO),
  };
}

function proposalDTO(p: ReturnType<typeof listProposals>[number]): ChatProposalDTO {
  const template = p.template_id ? getTemplate(p.template_id) : null;
  return {
    id: p.id,
    createdAt: p.created_at,
    templateId: p.template_id,
    templateName: template?.name ?? null,
    guardsSource:
      template !== null ? "template" : p.template_id ? "missing" : "defaults",
    guardsLabel: template
      ? template.name
      : p.template_id
        ? "template deleted"
        : defaultGuardsLabel(),
    promptRewritten: p.prompt_override !== null,
    title: p.title,
    task: p.task,
    folderLabel: folderLabel(p.mount_id, p.folder),
    status: p.status,
    runId: p.run_id,
    error: p.error,
  };
}

/**
 * What an untemplated proposal would be allowed to do, spelled out.
 *
 * A templated proposal says the template's name instead, because that is a
 * thing the operator wrote and can go and read. An untemplated one has no such
 * handle, so the card has to carry the guards themselves — otherwise the only
 * place the answer exists is a settings page two clicks away, and an approval
 * gate that does not show what is being approved is a gate that gets clicked
 * through.
 */
function defaultGuardsLabel(): string {
  const guards = chatGuards();
  const { maxIterations, maxDurationMinutes, maxRunCostUSD } = guards.budget;

  return [
    guards.permissionMode,
    guards.isolate ? "own checkout" : "your folder",
    maxIterations === null
      ? null
      : `${maxIterations} cycle${maxIterations === 1 ? "" : "s"}`,
    maxDurationMinutes === null ? null : `${maxDurationMinutes} min`,
    maxRunCostUSD === null ? null : fmtUSD(maxRunCostUSD),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Where a proposal would run, in the words the folder picker uses.
 *
 * Null when the proposal names no folder, which is not "nowhere" — it means
 * the template's folder is used, and the card says that instead of showing a
 * blank. The empty path is the mount root and is labelled as such, because it
 * is the one selection that blocks every other run in the tree and a reader
 * about to approve twenty proposals should see it.
 */
function folderLabel(mountId: string | null, folder: string | null): string | null {
  if (mountId === null) return null;
  const label = mountById(mountId)?.label ?? mountId;
  return folder ? `${label}/${folder}` : `${label} (mount root)`;
}

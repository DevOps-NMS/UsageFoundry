// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and Meter.tsx already do.
import {
  CHAT_TIMEOUT_MS,
  listChats,
  listMessages,
  listProposals,
  listQuestions,
  pendingProposals,
  pendingQuestions,
  proposalDeps,
  proposalGuards,
  questionChoices,
  type ChatQuestionRow,
  type ChatRow,
} from "../../../lib/chat";
import {
  currentKnowledge,
  summarizeProposedGraph,
  type WorkflowGraph,
  type WorkflowKnowledge,
} from "../../../lib/workflows";
import { getTemplate } from "../../../lib/templates";
import { getAgent } from "../../../lib/agents";
import { chatGuards, type RunGuards } from "../../../lib/settings";
import { mountById } from "../../../lib/config";
import { fmtUSD } from "../../../lib/format";
import type {
  ChatDTO,
  ChatListEntryDTO,
  ChatProposalDTO,
  ChatQuestionDTO,
  ProposedBlockDTO,
} from "../../../lib/apiTypes";

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
    turnStartedAt: chat.turn_started_at,
    turnTimeoutMs: CHAT_TIMEOUT_MS,
    messages: listMessages(chat.id).map((m) => ({
      id: m.id,
      ts: m.ts,
      role: m.role,
      text: m.text,
    })),
    proposals: proposalDTOs(listProposals(chat.id)),
    questions: listQuestions(chat.id).map(questionDTO),
  };
}

/**
 * One question, with its choices parsed on the way out.
 *
 * Parsed here rather than on the client for `proposalDTO`'s reason: the column
 * is JSON this module wrote, and a page that parsed it would be a second reader
 * of a format only `chat.ts` defines. `questionChoices` never throws, so a row
 * an older build left renders as a question with no shortlist rather than as a
 * chat page that 500s — and `allowText` is what decides whether that is still
 * answerable, which is why the two are separate fields.
 */
function questionDTO(q: ChatQuestionRow): ChatQuestionDTO {
  return {
    id: q.id,
    createdAt: q.created_at,
    question: q.question,
    choices: questionChoices(q),
    allowText: q.allow_text === 1,
    status: q.status,
    answer: q.answer,
    answeredAt: q.answered_at,
  };
}

/**
 * Every proposal of one thread, with what they all share read once.
 *
 * The template/mount knowledge is a database read and the chat page polls this
 * route every few seconds, so it is taken per request rather than per proposal.
 * `currentKnowledge()` is only read when a workflow proposal is actually there,
 * which on nearly every thread is never.
 *
 * The untemplated guard set is here for a *second* reason now, and the two
 * point opposite ways. Taking it per request used to be the whole answer, and
 * it made the label live: the card was re-derived from `chatGuards()` on every
 * poll, so it changed under the operator between renders and the run took a
 * third reading at the click. An untemplated proposal now freezes its own set
 * when it is written, so the card is drawn from the row and cannot go stale —
 * see `proposalGuards`. What is read here is only what a row *without* one
 * falls back to: a proposal from before the column, or a blob nothing can read.
 * A value already on the row is cheaper than this read rather than dearer, so
 * nothing about the polling cost argues the other way.
 */
function proposalDTOs(
  rows: ReturnType<typeof listProposals>,
): ChatProposalDTO[] {
  const untemplated = spellGuards(chatGuards());
  const known = rows.some((p) => p.kind === "workflow")
    ? currentKnowledge()
    : null;
  return rows.map((p) => proposalDTO(p, untemplated, known));
}

/**
 * The chat list, as every chat GET answers with it.
 *
 * Here rather than in the list route because the *single-chat* route returns it
 * too: that is the only route the page polls, so a list assembled by the list
 * route alone is fetched once on mount and then stops describing reality — a
 * thread stays "Untitled" after `finishTurn` names it, and a waiting count
 * never moves. Sharing the projection is the same rule `chatDTO` follows: two
 * routes that answer about the same rows must not answer differently.
 */
export function chatListDTO(): ChatListEntryDTO[] {
  return listChats().map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updated_at,
    status: c.status,
    costUSD: c.cost_usd,
    pendingCount: pendingProposals(c.id).length,
    pendingQuestionCount: pendingQuestions(c.id).length,
  }));
}

function proposalDTO(
  p: ReturnType<typeof listProposals>[number],
  untemplated: string,
  known: WorkflowKnowledge | null,
): ChatProposalDTO {
  const template = p.template_id ? getTemplate(p.template_id) : null;
  // Resolved here rather than on the client for the template's reason: the name
  // is in the registry and the row holds an id, so a card that did not resolve
  // it could only show the id — and could not tell "no agent" from "the agent
  // is gone", which is the one of the two that approval refuses.
  // An agent the CLI would not register counts as missing: `planProposal` refuses it,
  // so a card calling it fine would be a card the click contradicts.
  const agent = p.agent_id ? getAgent(p.agent_id) : null;
  // The set this proposal froze, or null for a row that froze none — which is
  // every templated and every workflow proposal, and every run proposal made
  // before the column existed. Those fall back to `untemplated`, the live set,
  // which is what this card showed however the guards were resolved.
  const frozen = proposalGuards(p);
  return {
    id: p.id,
    createdAt: p.created_at,
    kind: p.kind,
    templateId: p.template_id,
    templateName: template?.name ?? null,
    guardsSource:
      template !== null ? "template" : p.template_id ? "missing" : "defaults",
    guardsLabel: template
      ? template.name
      : p.template_id
        ? "template deleted"
        : frozen
          ? spellGuards(frozen)
          : untemplated,
    // The figures behind the name, and only where a name is all the card shows.
    // An untemplated proposal already spells them out one field up — off its own
    // frozen set where it has one — and a deleted template has nothing left to
    // read them off, which is the fact `guardsSource: "missing"` carries and
    // approval refuses on.
    guardsDetail: template ? spellGuards(template) : null,
    promptOverride: p.prompt_override,
    agentName: agent?.name ?? null,
    // Truthy rather than `!== null`, `planProposal`'s rule: a row written before
    // the column existed reads as no agent rather than as a missing one.
    agentMissing: Boolean(p.agent_id) && (agent === null || !agent.usable),
    // The row's own, and deliberately not `?? template?.model`: a card that
    // spells a value out promises the run starts under it, and a template's
    // model is a handle read live at the click for exactly the reason its
    // guards are. Trimmed to null the way the plan reads it, so a row carrying
    // whitespace draws no row rather than an empty one.
    model: p.model?.trim() || null,
    title: p.title,
    task: p.task,
    folderLabel: folderLabel(p.mount_id, p.folder),
    specId: p.spec_id,
    dependsOn: proposalDeps(p).map((d) => ({
      label: d.specId,
      edge: d.edge,
      continueBranch: d.continueBranch,
    })),
    blocks: known ? proposedBlocks(p.graph, known, untemplated) : [],
    status: p.status,
    runId: p.run_id,
    workflowId: p.workflow_id,
    error: p.error,
  };
}

/**
 * A workflow proposal's blocks, or nothing.
 *
 * Resolved here rather than on the client for `proposalDTO`'s own reason: the
 * guards are not on the graph, they are on the templates it names, and a
 * template deleted between the proposal and the click is the same fact
 * `guardsSource: "missing"` already carries one level down. A graph that cannot
 * be read at all yields no blocks rather than throwing — the card then shows
 * the title and the summary, and approval refuses it by name.
 */
function proposedBlocks(
  raw: string | null,
  known: WorkflowKnowledge,
  untemplated: string,
): ProposedBlockDTO[] {
  if (!raw) return [];
  try {
    return summarizeProposedGraph(
      JSON.parse(raw) as WorkflowGraph,
      known,
      untemplated,
    );
  } catch {
    return [];
  }
}

/**
 * A guard set spelled out, whoever it belongs to.
 *
 * Three callers and one string on purpose — the live default set, the set an
 * untemplated proposal froze when it was written, and a template's own figures.
 * The card says a *template's* name rather than those figures, because that is a
 * thing the operator wrote and can go and read, and an untemplated proposal has
 * no such handle — so the card has to carry those guards itself, otherwise the
 * only place the answer exists is a settings page two clicks away, and an
 * approval gate that does not show what is being approved is a gate that gets
 * clicked through. That argument stopped one step short: `Bug fix` names the
 * rules without stating them, so the same sentence applies to the template's own
 * numbers, which is what `guardsDetail` carries behind the card's fold. Written
 * by *this* function rather than by a second one beside it, since two spellings
 * of one guard set are two things to keep in step and the day they diverge the
 * card asserts a ceiling the run does not have — which is the same reason a card
 * drawn from a frozen set and one drawn from the live set are spelled by this
 * one function: differing in *wording* would read as the guards having changed
 * when they had not.
 *
 * The promise in those figures is also why an untemplated proposal freezes its
 * set onto its own row: values on a card are a promise, and a promise
 * re-derived on every poll is one the operator can be shown and never given.
 * The live set stays as the fallback for a row carrying none, and as what a
 * *workflow* proposal's blocks are summarised against — approving one of those
 * saves a graph rather than starting anything, so the guards it names are read
 * when somebody presses Run.
 *
 * `RunGuards` rather than three arguments because that is already the name of
 * this triple, and a `RunTemplate` satisfies it as it stands.
 */
export function spellGuards(guards: RunGuards): string {
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

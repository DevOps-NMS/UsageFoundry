"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_NAME,
  type AgentDTO,
  type AmbientAgentDTO,
} from "@/lib/apiTypes";
import {
  EMPTY_AGENT_DRAFT,
  agentDraft,
  agentIncompleteReason,
  agentPayload,
  ambientClash,
  type AgentDraft,
} from "@/lib/agentRegistry";
import { pollFailureMessage, shortPath } from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import {
  TBody,
  THead,
  Table,
  TableWrap,
  Td,
  Th,
  Tr,
} from "@/components/ui/Table";

/**
 * The registry, and the only place in this app that writes to it.
 *
 * `POST`, `PUT` and `DELETE /api/agents` shipped with the feature and no client
 * called any of them, so on every install the four surfaces that *read* the
 * registry — the run form's Specialist row, the Settings default, the workflow
 * canvas and the chat's `@` popover — offered an empty list for ever. This is
 * the page that fills it.
 *
 * **What this form may hold is the whole design, and it is an absence.** An
 * agent is a name, a description, a prompt and optionally a model. There is no
 * permission mode here, no budget, no folder, no isolation choice and no tool
 * list, because what an agent may do comes from the guard set on the run it is
 * delegated inside — the routes to `--permission-mode` are two and a saved
 * record reachable from a chat proposal or a workflow block must not become a
 * third. A control for any of those on this page would be the defect rather
 * than the feature, whatever it was labelled. `agentPayload` is where that is
 * enforced rather than remembered.
 *
 * **Nothing here decides what an agent may be.** `normalizeAgentInput` refuses
 * five shapes the CLI itself accepts and then silently ignores, and each refusal
 * is a paragraph written to be *shown*; the server stays the authority and this
 * page renders the sentence it gets back, which is `/api/workflows/validate`'s
 * rule and its reason — a second copy of those rules in the browser would be a
 * second set to keep in step, confidently wrong about what Save does the day one
 * of them changed.
 */

/** No poll. Nothing but this page writes the registry, so nothing moves under it. */
export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [ambient, setAmbient] = useState<AmbientAgentDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // `null` is the editor closed; an id is an edit and `null` inside it a
  // creation, which is what the two routes differ by and nothing else.
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_AGENT_DRAFT);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<AgentDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const res = await jsonRequest<{ agents?: AgentDTO[]; ambient?: AmbientAgentDTO[] }>(
      "/api/agents",
    );
    if (!res.ok || !res.data.agents) {
      setLoadError(
        pollFailureMessage(
          res.ok ? 200 : res.status,
          res.ok ? "no agents in the response" : res.error,
        ),
      );
      setLoaded(true);
      return;
    }
    setAgents(res.data.agents);
    setAmbient(res.data.ambient ?? []);
    setLoadError(null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openNew() {
    setEditing({ id: null });
    setDraft(EMPTY_AGENT_DRAFT);
    setSaveError(null);
    setNote(null);
  }

  function openEdit(agent: AgentDTO) {
    setEditing({ id: agent.id });
    setDraft(agentDraft(agent));
    setSaveError(null);
    setNote(null);
  }

  function closeEditor() {
    setEditing(null);
    setSaveError(null);
  }

  async function save() {
    if (!editing || saving) return;
    setSaving(true);
    setSaveError(null);
    const res = await jsonRequest<{ agent: AgentDTO }>(
      editing.id ? `/api/agents/${editing.id}` : "/api/agents",
      { method: editing.id ? "PUT" : "POST", body: agentPayload(draft) },
    );
    setSaving(false);

    if (!res.ok) {
      // Whatever the server said, verbatim. Every refusal it can give names a
      // field and says what Claude Code would do with the row as it stands, and
      // a page that replaced that with "Could not save the agent" would send the
      // operator back to the same form with the same text in it.
      setSaveError(actionFailureMessage(res, "Could not save the agent."));
      return;
    }

    setNote(
      editing.id
        ? `Updated “${res.data.agent.name}”`
        : `Saved “${res.data.agent.name}”`,
    );
    setEditing(null);
    await load();
  }

  async function remove() {
    const agent = confirmDelete;
    if (!agent || deleting) return;
    setDeleting(true);
    const res = await jsonRequest<{ ok: true }>(`/api/agents/${agent.id}`, {
      method: "DELETE",
    });
    setDeleting(false);
    setConfirmDelete(null);

    if (!res.ok) {
      setSaveError(actionFailureMessage(res, "Could not delete the agent."));
      return;
    }
    setNote(`Deleted “${agent.name}”`);
    setEditing(null);
    await load();
  }

  const clash = ambientClash(draft.name, ambient);
  const editingAgent = editing?.id
    ? (agents.find((a) => a.id === editing.id) ?? null)
    : null;
  const decayed = editingAgent ? agentIncompleteReason(editingAgent) : null;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-semibold tracking-tight">Agents</h1>
          <p className="max-w-[68ch] text-ink-muted">
            A saved <strong className="font-semibold text-ink">agent</strong> is a
            specialist a run’s Claude may hand a subtask to. Naming one changes
            who does part of the work; it never changes what the run may do.
          </p>
        </div>
        {!editing && (
          <Button variant="primary" onClick={openNew}>
            New agent
          </Button>
        )}
      </div>

      <div role="alert">{loadError && <Notice tone="danger">{loadError}</Notice>}</div>
      {note && (
        <Notice tone="info" live>
          {note}
        </Notice>
      )}

      {editing && (
        <>
          <CardTitle>{editing.id ? "Edit agent" : "New agent"}</CardTitle>
          {/* The one thing the page is about while it is open, so it takes the
              emphasis and the list below gives it up. */}
          <Card emphasis="primary" className="mb-6">
            {decayed && (
              <Hint tone="warn" className="mb-3.5">
                {decayed}
              </Hint>
            )}

            <Field
              label="Name"
              htmlFor="agent-name"
              hint="What Claude calls this agent when it delegates"
              hintTone={clash ? "warn" : "neutral"}
            >
              <Input
                id="agent-name"
                value={draft.name}
                maxLength={MAX_AGENT_NAME}
                autoFocus
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            {/* Annotated, never refused. A saved agent and a file on disk under
                one name is a state this app cannot resolve — the ambient set is
                per-cwd and which definition Claude Code uses is unverified — so
                the operator is told, and left to decide. */}
            {clash && (
              // The pull-up is on a wrapper because `Hint` states its own
              // `mt-1.5`, and Tailwind emits a numeric utility's values
              // ascending — so a caller's `-mt-2` on the component itself
              // loses to the larger value the component wrote and the class
              // reads as a pull-up while rendering a 6px push-down. A caller
              // that has to cancel a component's own spacing does it on a
              // wrapper; `mb-3.5` stays where it is, since `Hint` states no
              // bottom margin for it to lose to.
              <div className="-mt-2">
                <Hint tone="warn" className="mb-3.5">
                  Your own {shortPath(clash.path)} already defines an agent called “
                  {clash.name}”. Both reach the same run and which one Claude Code
                  uses is not something this app can determine
                </Hint>
              </div>
            )}

            <Field
              label="Description"
              htmlFor="agent-description"
              hint="The only thing Claude reads when it decides whether to hand this agent a subtask — and it is carried for the whole session, so it is paid for on every request the run makes"
            >
              <Textarea
                id="agent-description"
                value={draft.description}
                rows={3}
                maxLength={MAX_AGENT_DESCRIPTION}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>

            <Field
              label="Prompt"
              htmlFor="agent-prompt"
              hint="The agent’s own system prompt: the whole of what makes it different from the Claude that would have done the work anyway"
            >
              <Textarea
                id="agent-prompt"
                value={draft.prompt}
                rows={8}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            </Field>

            <Field
              label="Model"
              htmlFor="agent-model"
              hint="What the delegated turn runs on — an alias or a full id. Blank inherits the run’s. It moves cost, not capability: the spend lands on the run like any other turn"
            >
              <Input
                id="agent-model"
                value={draft.model}
                maxLength={MAX_AGENT_NAME}
                placeholder="inherit"
                className="max-w-sm"
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </Field>

            <div role="alert">
              {saveError && <Notice tone="danger">{saveError}</Notice>}
            </div>

            <ButtonRow className="justify-between">
              <div>
                {editingAgent && (
                  <Button
                    variant="danger"
                    onClick={() => setConfirmDelete(editingAgent)}
                  >
                    Delete
                  </Button>
                )}
              </div>
              <ButtonRow>
                <Button variant="secondary" onClick={closeEditor} disabled={saving}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={save} busy={saving}>
                  {editing.id ? "Save changes" : "Save agent"}
                </Button>
              </ButtonRow>
            </ButtonRow>
          </Card>
        </>
      )}

      <CardTitle>Saved</CardTitle>
      <Card emphasis={editing ? "default" : "primary"} className="mb-6">
        {!loaded ? (
          <div aria-busy="true">
            <span className="sr-only">Reading agents…</span>
            <SkeletonText lines={3} />
          </div>
        ) : agents.length === 0 ? (
          <Empty>
            <div className="font-medium text-ink">No agents yet</div>
            <div className="mx-auto mt-1 max-w-[52ch] text-ink-muted">
              A run, a template, a workflow block and the orchestrator chat can
              each name one. Until there is an agent here, every one of those
              pickers has nothing to offer.
            </div>
            <div className="mt-3">
              <Button variant="secondary" onClick={openNew}>
                Create one
              </Button>
            </div>
          </Empty>
        ) : (
          <TableWrap>
            <Table stack>
              <caption className="sr-only">Saved agents, by name</caption>
              {/* Floors rather than widths, and the difference is the whole of
                  it. `Table` is auto-layout, where a `width` is a suggestion
                  the algorithm is free to overrule and does the moment a
                  `w-full` column asks for everything left — measured, the
                  Agent column rendered 98px against the 200 declared here, so
                  a name wrapped to three lines beside a description that had
                  taken the room. A `min-width` is not a suggestion: it enters
                  the column's own minimum, so the wide column gives instead.
                  The figures are unchanged. */}
              <THead>
                <tr>
                  <Th scope="col" className="min-w-[200px]">
                    Agent
                  </Th>
                  <Th scope="col" className="w-full">
                    Description
                  </Th>
                  <Th scope="col" className="min-w-[160px]">
                    Model
                  </Th>
                </tr>
              </THead>
              <TBody>
                {agents.map((agent) => {
                  const onDisk = ambientClash(agent.name, ambient);
                  return (
                    <Tr key={agent.id}>
                      <Td className="align-top">
                        {/* `whitespace-nowrap` because the column is sized to
                            its content and a hyphen is a break opportunity:
                            `ts-coder` came apart as "ts-" over "coder" where
                            `typescript` two tables down, having no hyphen in
                            it, did not. Agent names are hyphenated by
                            convention, so this is the ordinary case rather
                            than an odd one, and a name is the handle the
                            operator picks the agent by.

                            `inline-flex` only below the breakpoint, where the
                            name is what opens the editor with a finger and owes
                            the app's 44px target; above it the row is aimed at
                            with a pointer and this stays the inline text it
                            reads as. */}
                        <button
                          type="button"
                          onClick={() => openEdit(agent)}
                          className="cursor-pointer whitespace-nowrap text-left font-medium text-ink hover:text-accent max-md:inline-flex max-md:min-h-11 max-md:items-center"
                        >
                          {agent.name}
                        </button>
                        {(!agent.usable || onDisk) && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {!agent.usable && <Badge tone="warn">incomplete</Badge>}
                            {onDisk && <Badge tone="warn">name clash</Badge>}
                          </div>
                        )}
                      </Td>
                      {/* The name sits over the value rather than beside it:
                          this is a paragraph an agent is chosen on, and in the
                          right half of a 390px row it is a four-word column. */}
                      <Td
                        label="Description"
                        labelPlacement="above"
                        className="align-top text-ink-muted"
                      >
                        <span className="block max-w-[70ch]">
                          {agent.description || "—"}
                        </span>
                      </Td>
                      <Td
                        label="Model"
                        className="align-top whitespace-nowrap text-ink-muted"
                      >
                        {agent.model ? (
                          <span className="mono">{agent.model}</span>
                        ) : (
                          "inherits the run’s"
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {/* The registry is a part of the set and not the whole of it. Said here at
          length because this is the page where somebody would otherwise conclude
          that an empty table means no agents are in play. */}
      <CardTitle>On disk</CardTitle>
      <Card emphasis="quiet">
        {ambient.length === 0 ? (
          <Empty>
            <div className="text-ink-muted">
              Nothing in your own <span className="mono">~/.claude/agents</span>
            </div>
          </Empty>
        ) : (
          <TableWrap>
            <Table stack>
              <caption className="sr-only">
                Agent definitions in ~/.claude/agents, which this app did not write
              </caption>
              <THead>
                <tr>
                  <Th scope="col" className="min-w-[200px]">
                    Agent
                  </Th>
                  <Th scope="col" className="w-full">
                    Description
                  </Th>
                  <Th scope="col" className="min-w-[240px]">
                    File
                  </Th>
                </tr>
              </THead>
              <TBody>
                {ambient.map((a) => (
                  <Tr key={a.path}>
                    <Td className="align-top font-medium text-ink">{a.name}</Td>
                    <Td
                      label="Description"
                      labelPlacement="above"
                      className="align-top text-ink-muted"
                    >
                      <span className="block max-w-[70ch]">
                        {a.description ?? "— no description in the file —"}
                      </span>
                    </Td>
                    {/* Above the value for the description's reason: a path is
                        the widest thing in the row and the one that has to stay
                        whole, since it is the only handle this table can give. */}
                    <Td
                      label="File"
                      labelPlacement="above"
                      // A path has no space in it to wrap at, so below the
                      // breakpoint it is the one value here that can push the
                      // pane sideways on its own.
                      className="mono align-top text-ink-faint max-md:break-all"
                    >
                      {shortPath(a.path)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
        <Hint className="mt-3">
          These already reach every run, chat turn, deciding block and review this
          app spawns, whatever is saved above — naming a saved agent merges with
          them rather than replacing them. They cannot be picked here: a picker
          needs a handle this app can store, and a file on disk has only its path.
          Only your own <span className="mono">~/.claude</span> is listed — a
          repository’s own <span className="mono">.claude/agents</span> reaches an
          isolated run’s checkout too, and which one that is depends on the folder
          the run was given.
        </Hint>
      </Card>

      <Sheet
        open={confirmDelete !== null}
        onDismiss={() => setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.name ?? ""}”?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        busy={deleting}
        onConfirm={remove}
      >
        <p>
          The prompt goes with it and there is no undo. A run already in flight
          keeps its own copy of the definition, so nothing running is affected.
        </p>
        <p className="mt-2">
          Anything that <em>names</em> this agent — a template, a workflow block, a
          chat proposal, the Settings default — refuses to start rather than
          quietly starting without a specialist, so check those before deleting.
        </p>
      </Sheet>
    </>
  );
}

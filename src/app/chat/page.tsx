"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ChatDTO, ChatListEntryDTO, ChatProposalDTO } from "@/lib/apiTypes";
import { chatRequest } from "@/lib/chatRequest";
import { fmtRelative, fmtUSD, pollFailureMessage } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";

/**
 * The orchestrator chat.
 *
 * Two halves that mean different things and are kept visually apart for that
 * reason: a conversation, which costs money and produces text, and a list of
 * proposals, which costs nothing until a person clicks. Nothing in the left
 * half starts work. Everything that does is a button in the right half.
 */

/** Faster only while a turn is in flight — the same rule the dashboard follows. */
const POLL_IDLE_MS = 10_000;
const POLL_ACTIVE_MS = 3_000;

const PROPOSAL_TONE = {
  pending: "accent",
  approved: "ok",
  rejected: "neutral",
  failed: "danger",
} as const;

export default function ChatPage() {
  const [chat, setChat] = useState<ChatDTO | null>(null);
  const [chats, setChats] = useState<ChatListEntryDTO[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`, which the send and approve handlers own: they clear
  // theirs on every click, and a poll lands between clicks — one state would
  // have each wiping the other's sentence seconds after it appeared.
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const threadRef = useRef<HTMLDivElement>(null);

  const chatId = chat?.id ?? null;

  /**
   * Neither failure may be dropped. A poll that returns early leaves the last
   * snapshot on screen as though it were current — a thread that was thinking
   * when the polls started failing then shows "Thinking…" for ever, which is
   * indistinguishable from a turn still working.
   */
  const load = useCallback(async (id: string | null) => {
    try {
      const res = await fetch(id ? `/api/chat/${id}` : "/api/chat", { cache: "no-store" });
      // Parsed before the status check: a 500 from inside `chatDTO` carries no
      // JSON, and letting that throw would report a reachable server as an
      // unreachable one.
      const data = (await res.json().catch(() => ({}))) as {
        chat?: ChatDTO;
        chats?: ChatListEntryDTO[];
        error?: string;
      };
      if (!res.ok || !data.chat) {
        const detail = data.error ?? (res.ok ? "no thread in the response" : null);
        setPollError(pollFailureMessage(res.status, detail));
        return;
      }
      setChat(data.chat);
      // Both routes answer with the list, so this lands on every poll. Still
      // guarded: the body above is untrusted, and a payload without it must
      // leave the sidebar as it was rather than emptying it.
      if (data.chats) setChats(data.chats);
      setPollError(null);
    } catch (err) {
      // `void load(id)` from an interval: without this the rejection is an
      // unhandled one and, again, nothing on screen changes.
      const cause = err instanceof Error ? err.message : String(err);
      setPollError(pollFailureMessage(null, cause));
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  // Both halves come back from this one request — the thread route answers with
  // the list too — so the list stays current on the thread's own period and
  // never on a timer of its own.
  // No `if (!chatId) return`: a first load that fails leaves no thread to poll
  // for, so the guard that used to stand here meant the page never tried again
  // and the failure notice stood for ever. The cadence is unchanged — with no
  // thread there is no `thinking` status, so this is the idle timer.
  useEffect(() => {
    const period = chat?.status === "thinking" ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const t = setInterval(() => void load(chatId), period);
    return () => clearInterval(t);
  }, [chatId, chat?.status, load]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [chat?.messages.length, chat?.status]);

  const send = async () => {
    const message = draft.trim();
    if (!message || !chatId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await chatRequest(`/api/chat/${chatId}/message`, { message });
      if (!result.ok) setError(result.error ?? "The message could not be sent.");
      else {
        setDraft("");
        if (result.chat) setChat(result.chat);
      }
    } finally {
      // `busy` disables every button here at once and only this line clears it,
      // so it is released on the way out however the request ended. No `catch`:
      // `chatRequest` returns the transport failure instead of throwing it, and
      // anything still reaching here is a bug that should not be swallowed.
      setBusy(false);
    }
  };

  /**
   * Stop a turn that is not going to finish.
   *
   * The only way back from a thread stuck on "Thinking…" short of restarting
   * the server — which stops every run in flight to clear one conversation. It
   * is deliberately not a send: the guard that refuses a message while a turn
   * is in flight is what stops two billed children on one conversation.
   */
  const stop = async () => {
    if (!chatId || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/chat/${chatId}/cancel`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as {
      chat?: ChatDTO;
      error?: string;
    };
    if (!res.ok) setError(data.error ?? "The turn could not be stopped.");
    else if (data.chat) setChat(data.chat);
    setBusy(false);
  };

  const decide = async (action: "approve" | "reject", ids: string[]) => {
    if (!chatId || ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await chatRequest(`/api/chat/${chatId}/proposals`, { action, ids });
      if (!result.ok) setError(result.error ?? "That could not be applied.");
      else {
        setSelected(new Set());
        if (result.chat) setChat(result.chat);
      }
    } finally {
      setBusy(false);
    }
  };

  const newChat = async () => {
    const res = await fetch("/api/chat", { method: "POST" });
    if (!res.ok) return;
    const data = (await res.json()) as { chat: ChatDTO };
    setChat(data.chat);
    setSelected(new Set());
    void load(null);
  };

  const pending = (chat?.proposals ?? []).filter((p) => p.status === "pending");
  const decided = (chat?.proposals ?? []).filter((p) => p.status !== "pending");
  const thinking = chat?.status === "thinking";

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Orchestrator</h1>
        <div className="ml-auto flex items-center gap-2">
          {chat && chat.costUSD > 0 && (
            <span className="text-xs text-ink-muted">
              This chat has spent {fmtUSD(chat.costUSD)}
            </span>
          )}
          <Button variant="secondary" onClick={() => void newChat()}>
            New chat
          </Button>
        </div>
      </div>

      <Notice tone="info" quiet>
        <strong>Nothing here starts a run.</strong> The chat can only propose
        work; each proposal waits for you to approve it, and it then runs under
        the guards of the template it names, or under the default guard set in{" "}
        <Link href="/settings">Settings</Link> when it names none — never under
        anything the chat chose. A chat turn spends against the same 5-hour
        window as everything else, and its cost is shown here only, never added
        to a run&rsquo;s or to the dashboard meters.
        <br />
        The chat itself runs with no tool restrictions, so it can read, run
        commands and reach GitHub while it works out what to propose. It is
        instructed not to do the work — that instruction, not a permission mode,
        is what keeps it out of your checkouts.
      </Notice>

      {pollError && <Notice tone="danger">{pollError}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {chat?.error && chat.status === "failed" && (
        <Notice tone="danger">{chat.error}</Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card emphasis="primary" className="flex min-h-[60vh] flex-col">
          <div
            ref={threadRef}
            className="mb-3 flex-1 overflow-y-auto"
            style={{ maxHeight: "60vh" }}
          >
            {chat && chat.messages.length === 0 ? (
              <Empty>
                Ask it to look at something — &ldquo;check the open issues on
                usagefoundry and propose a run for each bug&rdquo;.
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {chat?.messages.map((m) => (
                  <Message key={m.id} role={m.role} text={m.text} ts={m.ts} />
                ))}
                {thinking && (
                  // `thinking` is only ever as fresh as the last poll that
                  // worked, so once one has failed this may no longer be true.
                  <div className="text-sm text-ink-faint">
                    {pollError
                      ? "Was thinking when the last refresh failed — state unknown."
                      : "Thinking…"}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-line pt-3">
            <textarea
              className="w-full resize-y rounded-sm border border-line bg-inset px-2.5 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-dim"
              rows={3}
              placeholder="Ask the orchestrator to look at something and propose runs…"
              value={draft}
              disabled={thinking}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <ButtonRow className="mt-2">
              <Button onClick={() => void send()} disabled={thinking || busy || !draft.trim()}>
                {thinking ? "Working…" : "Send"}
              </Button>
              {thinking && (
                <Button variant="secondary" disabled={busy} onClick={() => void stop()}>
                  Stop
                </Button>
              )}
              <Hint className="mt-0">
                {thinking
                  ? "Stop ends this turn and signals the process answering it."
                  : "Enter sends, Shift+Enter adds a line."}
              </Hint>
            </ButtonRow>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>
              Proposals
              {pending.length > 0 && <Badge tone="accent">{pending.length} waiting</Badge>}
            </CardTitle>

            {pending.length === 0 ? (
              <Empty>Nothing waiting for approval.</Empty>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {pending.map((p) => (
                    <Proposal
                      key={p.id}
                      proposal={p}
                      checked={selected.has(p.id)}
                      onToggle={() => toggle(p.id)}
                    />
                  ))}
                </div>
                <ButtonRow className="mt-3">
                  <Button
                    disabled={busy || selected.size === 0}
                    onClick={() => void decide("approve", [...selected])}
                  >
                    Approve {selected.size || ""}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || selected.size === 0}
                    onClick={() => void decide("reject", [...selected])}
                  >
                    Reject
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      setSelected(
                        selected.size === pending.length
                          ? new Set()
                          : new Set(pending.map((p) => p.id)),
                      )
                    }
                  >
                    {selected.size === pending.length ? "Select none" : "Select all"}
                  </Button>
                </ButtonRow>
                <Hint>
                  Approving starts each one as a real run under the guards shown
                  on it. Runs beyond the concurrency limit queue rather than
                  being refused.
                </Hint>
              </>
            )}
          </Card>

          {decided.length > 0 && (
            <Card emphasis="quiet">
              <CardTitle>Decided</CardTitle>
              <div className="flex flex-col gap-2">
                {decided.slice().reverse().map((p) => (
                  <div key={p.id} className="text-xs">
                    <div className="flex items-center gap-2">
                      <Badge tone={PROPOSAL_TONE[p.status]}>{p.status}</Badge>
                      {p.runId ? (
                        <Link href={`/runs/${p.runId}`}>{p.title}</Link>
                      ) : (
                        <span className="text-ink-muted">{p.title}</span>
                      )}
                    </div>
                    {p.error && <Hint tone="danger">{p.error}</Hint>}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {chats.length > 1 && (
            <Card emphasis="quiet">
              <CardTitle>Earlier chats</CardTitle>
              <div className="flex flex-col gap-1.5">
                {chats
                  .filter((c) => c.id !== chatId)
                  .map((c) => (
                    // Two lines, because one truncated line in a 360px column
                    // was all title: an 80-character first message clipped away
                    // both the time and the waiting count, which are the only
                    // two things telling these rows apart. Only the title
                    // truncates now, and it carries the full string for hover
                    // and assistive tech — the pairing RunCard already uses.
                    <button
                      key={c.id}
                      onClick={() => {
                        // Ticked ids belong to the thread they were ticked in.
                        // `newChat` clears them for the same reason; carried
                        // over, they describe proposals not on screen and are
                        // sent to a chat that has never held them.
                        setSelected(new Set());
                        void load(c.id);
                      }}
                      title={c.title ?? "Untitled"}
                      className="cursor-pointer text-left text-xs text-ink-muted hover:text-ink"
                    >
                      <span className="block truncate">
                        {c.title ?? "Untitled"}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-faint">
                        {fmtRelative(c.updatedAt)}
                        {c.pendingCount > 0 && (
                          <Badge tone="accent">{c.pendingCount} waiting</Badge>
                        )}
                      </span>
                    </button>
                  ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * One turn.
 *
 * `system` is this app speaking, not the model — a refused tool call, an
 * approval outcome, a failure. Styled apart from `assistant` on purpose: a
 * sentence about what the app did, rendered as though the model said it, is a
 * sentence the operator will later attribute to the wrong party.
 */
function Message({
  role,
  text,
  ts,
}: {
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}) {
  if (role === "system") {
    return (
      <div className="rounded-sm border border-line border-l-[3px] border-l-ink-faint bg-inset px-3 py-2 text-xs text-ink-muted">
        {text}
      </div>
    );
  }
  const mine = role === "user";
  return (
    <div className={mine ? "self-end max-w-[85%]" : "max-w-[95%]"}>
      <div
        className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          mine ? "bg-accent-dim text-ink" : "bg-inset text-ink"
        }`}
      >
        {text}
      </div>
      <div className="mt-0.5 text-2xs text-ink-faint">{fmtRelative(ts)}</div>
    </div>
  );
}

function Proposal({
  proposal,
  checked,
  onToggle,
}: {
  proposal: ChatProposalDTO;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer gap-2 rounded-sm border border-line bg-inset p-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{proposal.title}</div>
        <div className="mt-0.5 line-clamp-3 text-xs text-ink-muted">
          {proposal.task}
        </div>
        <div className="mt-1 text-2xs text-ink-faint">
          {proposal.folderLabel ?? "folder from the template"} ·{" "}
          {proposal.guardsSource === "missing" ? (
            <span className="text-danger">template deleted</span>
          ) : (
            proposal.guardsLabel
          )}
          {proposal.promptRewritten && " · prompt rewritten"}
        </div>
      </div>
    </label>
  );
}

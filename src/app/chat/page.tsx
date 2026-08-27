"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  AgentDTO,
  AmbientAgentDTO,
  ChatDTO,
  ChatListEntryDTO,
  ChatMessageDTO,
  ChatProposalDTO,
  ChatQuestionDTO,
  ProposedBlockDTO,
} from "@/lib/apiTypes";
import { chatRequest } from "@/lib/chatRequest";
import { threadItems } from "@/lib/chatThread";
import {
  describeAmbientAgents,
  fmtDateTime,
  fmtDuration,
  fmtRelative,
  fmtUSD,
  pollFailureMessage,
} from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow, type ButtonVariant } from "@/components/ui/Button";
import { Card, CardTitle, Empty, type CardEmphasis } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Icon } from "@/components/ui/Icon";
import { ListGroup } from "@/components/ui/List";
import { Spinner } from "@/components/ui/Log";
import { Notice } from "@/components/ui/Notice";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";

/**
 * The orchestrator chat.
 *
 * Two halves that mean different things and are kept visually apart for that
 * reason: a conversation, which costs money and produces text, and a list of
 * proposals, which costs nothing until a person clicks. Nothing in the left
 * half starts work. Everything that does is a button in the right half — which
 * is why a proposal is drawn as an object with a border, a folder and a guard
 * set rather than as another paragraph in the thread, and why the approve row
 * says how many unattended runs the click starts.
 */

/** Faster only while a turn is in flight — the same rule the dashboard follows. */
const POLL_IDLE_MS = 10_000;
const POLL_ACTIVE_MS = 3_000;

/**
 * Within this of the bottom counts as reading the latest, so an arriving turn
 * follows the reader down. Past it the page must not move at all: a poll that
 * scrolls somebody out of the paragraph they are reading is the one jank this
 * page can produce on its own.
 */
const NEAR_BOTTOM_PX = 48;

/** About ten lines. Past that the composer scrolls rather than eating the thread. */
const COMPOSER_MAX_PX = 208;

/**
 * How many saved agents the mention list offers at once.
 *
 * A completion list is read at a glance or not at all, and this one sits over
 * the conversation. Past a handful the answer is a narrower query, not a
 * taller popover.
 */
const MENTION_LIMIT = 6;

/** Complete class strings per state, never interpolated — the kit's rule. */
const MENTION_ROW: Record<"active" | "idle", string> = {
  active: "bg-selection",
  idle: "bg-transparent",
};

/** Where an `@`-mention starts in the draft, and what has been typed after it. */
interface MentionToken {
  /** Index of the `@` itself, so an insertion replaces the whole token. */
  start: number;
  query: string;
}

/**
 * The `@`-mention under the caret, or null.
 *
 * **What this is, before what it does.** The chat's child is `claude -p`, so
 * there is no interactive `@` on the wire and nothing here completes into the
 * model's own context: a mention is *text the operator writes*, and what it
 * does is tell the orchestrator which saved agent to start the proposed run as.
 * It names the *run's* agent and never this turn's — the chat's own child is
 * deliberately started as none, which `chat.ts` argues beside `runTurn`.
 * The orchestrator reads it, calls `list_agents`, and passes an `agentId` to
 * `propose_run` — where the agent is refused by name if it has gone. This app
 * never parses the mention back out of the message, which is why a name with a
 * space in it is inserted as it stands rather than quoted into a syntax nobody
 * else here speaks: the only reader is a model that has the list.
 *
 * Pure, and it only ever looks left from the caret. Two rules bound it, and
 * both exist to stop ordinary prose opening a list over the conversation: the
 * `@` has to open a word, so `user@host` is an address rather than a mention;
 * and a mention is one word, so the first space closes it instead of reading
 * the rest of a paragraph as a very long agent name.
 */
function mentionAt(text: string, caret: number): MentionToken | null {
  const upto = text.slice(0, caret);
  const start = upto.lastIndexOf("@");
  if (start === -1) return null;
  if (start > 0 && !/\s/.test(upto[start - 1])) return null;
  const query = upto.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, query };
}

const PROPOSAL_TONE = {
  pending: "accent",
  approved: "ok",
  rejected: "neutral",
  failed: "danger",
} as const;

/**
 * Complete class strings per state, never interpolated — Tailwind scans source
 * as text, so a computed class name emits nothing at all and does it silently.
 * Same rule the kit's own tone maps follow.
 *
 * A wash rather than a border, because these are now rows of one grouped box
 * and a row that gained a border on selection would shift the two beside it. It
 * is `--selection` — the app's own "this one" wash, which takes the operator's
 * accent where the browser exposes it — at an alpha that leaves the row's text
 * at its own contrast whatever that accent turns out to be.
 */
const PROPOSAL_ROW: Record<"selected" | "idle", string> = {
  selected: "bg-selection",
  idle: "bg-transparent hover:bg-fill-hover",
};

const GUARD_TONE: Record<"missing" | "set", string> = {
  missing: "text-danger",
  set: "text-ink-muted",
};

/**
 * The leading edge of a question card, per state. Complete class strings, the
 * kit's rule — an interpolated one emits nothing at all and does it silently.
 *
 * Accent while it is open, and only there. On this page accent already means
 * "this is waiting for you" — the proposals badge, the current row in the
 * thread list — and a question is the one thing in the *transcript* that is.
 * Settled, it takes the same neutral edge a `system` turn wears, because it is
 * then a record of what happened rather than something to do.
 */
const QUESTION_EDGE: Record<"open" | "settled", string> = {
  open: "border-l-accent",
  settled: "border-l-line-strong",
};

/**
 * A choice button, per state.
 *
 * Only reachable while more than one question is open — with one, a choice
 * *is* the answer and there is nothing to mark as chosen. See `AskedQuestions`.
 */
const CHOICE_VARIANT: Record<"chosen" | "offered", ButtonVariant> = {
  chosen: "primary",
  offered: "secondary",
};

/** What a proposed block is, in the words the workflow pages already use. */
const BLOCK_KIND: Record<ProposedBlockDTO["kind"], string> = {
  run: "run",
  orchestrator: "decides what to run",
  merge: "lands branches",
  loop: "repeats a task",
};

/**
 * `bg-transparent` and `font-normal` are not redundant: the legacy stylesheet
 * still styles every bare `button` as a filled accent control, so a row that
 * names no background gets one.
 */
const CHAT_ROW: Record<"current" | "other", string> = {
  current: "border-l-accent bg-accent-dim/40 text-ink",
  other: "border-l-transparent bg-transparent text-ink-muted hover:bg-inset hover:text-ink",
};

/** Shown by fading in place rather than by mounting, so nothing pops. */
const JUMP_STATE: Record<"shown" | "hidden", string> = {
  shown: "translate-y-0 opacity-100",
  hidden: "pointer-events-none translate-y-1 opacity-0",
};

/**
 * The card rises when it has something waiting for a decision.
 *
 * **This is the only card on the page allowed to move, and the conversation
 * beside it is deliberately not the other half of a pair.** Both were
 * `primary` at once, which by `Card`'s own rule means the page had no lead at
 * all — so one of them had to stop rising. The obvious repair was to make the
 * conversation the inverse of this map, and it is wrong: `emphasis` carries
 * padding as well as elevation (`p-5` against `p-4`), so a conversation keyed
 * on `pending` would re-pad the scrolled transcript and shift the composer
 * under the reader's hands the moment a proposal arrived — on a surface that
 * polls. This card holds neither a scroll position nor a text field, which is
 * exactly why it is the one that may change size.
 *
 * The conversation is therefore a flat `default` in every state, and the page
 * has one lead while something is waiting and none otherwise. That is a state
 * §1.1 names as legitimate, and on this page it is honest: with nothing
 * waiting, the thread is already the larger half by three columns and does not
 * need a shadow to say so.
 */
const PROPOSALS_EMPHASIS: Record<"waiting" | "clear", CardEmphasis> = {
  waiting: "primary",
  clear: "default",
};

/**
 * The three lists that stand beside the conversation, one at a time.
 *
 * They used to be three cards stacked in a 360px column, and a column is the
 * one arrangement that cannot bound them: proposals accumulate for as long as
 * nobody decides, decided ones accumulate for ever, and conversations do too —
 * so "which thread am I in" ended up several screens below a panel whose top
 * half was work already dealt with. One box with a tab bar is the same trade
 * the run page already makes for its five panes, and it is offered on the same
 * two rules: a tab exists only when there is something behind it, and **nothing
 * switches tabs on its own** — a proposal arriving while somebody is reading
 * another list must not move them. What that costs is a pending count nobody
 * can see from the other two tabs, which is why the badge beside the control is
 * drawn from any tab rather than on the Proposals segment.
 */
type SideTab = "proposals" | "decided" | "chats";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function ChatPage() {
  const [chat, setChat] = useState<ChatDTO | null>(null);
  const [chats, setChats] = useState<ChatListEntryDTO[]>([]);
  const [draft, setDraft] = useState("");
  // Three action errors rather than one, because each belongs beside the
  // control that failed: a refused approval reported above the composer is a
  // sentence about a button that is not on screen. `pollError` is separate
  // again — the handlers clear theirs on every click, and a poll lands between
  // clicks, so one state would have each wiping the other's sentence.
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  // A fourth, for the same reason there are three: the question card is in the
  // transcript, and a refused answer reported under the composer is a sentence
  // about buttons that may be several screens up.
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [side, setSide] = useState<SideTab>("proposals");
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  // The registry the composer completes from, and the definitions on disk this
  // app did not write — off one payload, so no surface here can describe the
  // set differently from the run form or the workflow canvas. A failed read
  // leaves the list empty and costs the completion, never the message: the
  // mention is text either way, and the orchestrator resolves it server-side.
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [ambient, setAmbient] = useState<AmbientAgentDTO[]>([]);
  const [mention, setMention] = useState<MentionToken | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  /**
   * The token offset Esc dismissed, so the list stays shut while it is typed.
   *
   * An offset rather than a boolean: a mention the operator dismissed must not
   * reopen on the next keystroke, and one they open later somewhere else must
   * not inherit that decision.
   */
  const [mentionClosed, setMentionClosed] = useState<number | null>(null);
  /** Where the caret goes after an insertion, applied once the draft has it. */
  const [caretTo, setCaretTo] = useState<number | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The scroll position the *effect* reads. State drives the button; a ref is
  // what tells an arriving message whether the reader was at the bottom, and it
  // must not be one render behind.
  const atBottomRef = useRef(true);
  const seen = useRef<{ chatId: string | null; count: number }>({
    chatId: null,
    count: 0,
  });

  const chatId = chat?.id ?? null;
  const thinking = chat?.status === "thinking";
  const messageCount = chat?.messages.length ?? 0;
  // Up here with the other derived facts rather than beside the proposal lists,
  // because an effect below depends on the count: a `const` declared after a
  // `useEffect` that names it in its dependency array is read before it is
  // initialised, and that is a ReferenceError on the first render rather than
  // anything subtle.
  const questions = chat?.questions ?? [];
  const openQuestions = questions.filter((q) => q.status === "pending").length;
  // The transcript with the questions put back where they were asked. Derived
  // on every render rather than held in state, for the reason the proposal
  // lists are: it is a projection of the poll's answer, and a copy would be one
  // more thing that can disagree with what the server just said.
  const items = threadItems(chat?.messages ?? [], questions);

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
      // A proposal this thread was holding can be decided somewhere this page
      // cannot see — another tab, another window — and its id then stays in
      // `selected` with no row left to untick. The route refuses it by id, so
      // nothing wrong reaches the data; what it costs is the two claims this
      // page makes about the selection. `allSelected` compares a size against
      // `pending.length` and so reads true while a visible row is unticked,
      // and "the explicit list of the ids the page displayed" becomes a
      // sentence about the render before this one. So the poll's answer is
      // what the set is reconciled against, here rather than in `pending`:
      // approval stays one synchronous pass over an explicit list of ids that
      // state holds, and deriving it from the render would be a different
      // gate. `prev` is returned unchanged where nothing was dropped, because
      // this runs on every poll and a fresh Set each time would re-render the
      // rows for nothing.
      const stillPending = new Set(
        data.chat.proposals.filter((p) => p.status === "pending").map((p) => p.id),
      );
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => stillPending.has(id)));
        return next.size === prev.size ? prev : next;
      });
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

  // Once, and deliberately not on the poll: the registry changes when somebody
  // edits it on another page, which is not something this composer has to track
  // between keystrokes. A failure is swallowed for the reason stated where the
  // state is declared — it costs a completion, and the door still decides.
  useEffect(() => {
    let live = true;
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { agents?: AgentDTO[]; ambient?: AmbientAgentDTO[] }) => {
        if (!live) return;
        setAgents(d.agents ?? []);
        setAmbient(d.ambient ?? []);
      })
      .catch(() => void 0);
    return () => {
      live = false;
    };
  }, []);

  // Both halves come back from this one request — the thread route answers with
  // the list too — so the list stays current on the thread's own period and
  // never on a timer of its own.
  // No `if (!chatId) return`: a first load that fails leaves no thread to poll
  // for, so the guard that used to stand here meant the page never tried again
  // and the failure notice stood for ever. The cadence is unchanged — with no
  // thread there is no `thinking` status, so this is the idle timer.
  //
  // **A chat waiting on an answer stays on the idle period, and that is a
  // decision rather than an omission.** The fast cadence exists to catch a turn
  // landing; a chat with a question open has no child and nothing on the server
  // can produce the answer, so three-second polling would be three times the
  // requests for a row that cannot move until a person clicks. It does not
  // stand down either, which is the half worth stating: the answer can arrive
  // from another tab, and the thread list beside it moves for reasons that have
  // nothing to do with this conversation — so ten seconds, not never.
  useEffect(() => {
    const period = chat?.status === "thinking" ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const t = setInterval(() => void load(chatId), period);
    return () => clearInterval(t);
  }, [chatId, chat?.status, load]);

  const scrollToLatest = useCallback((smooth: boolean) => {
    const el = threadRef.current;
    if (!el) return;
    // `behavior` is not covered by the reduced-motion rule in globals.css —
    // that one can only flatten CSS transitions, and this is a scroll.
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  }, []);

  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottomRef.current = near;
    setAtBottom(near);
    if (near) setUnseen(0);
  };

  /**
   * The one place the thread is allowed to move on its own.
   *
   * A poll that adds nothing moves nothing, and a poll that adds a turn moves
   * the view only for a reader who was already at the bottom. Everyone else
   * gets a count on the jump control instead — the alternative is being pulled
   * out of the paragraph you were reading every three seconds while a turn
   * lands.
   */
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (seen.current.chatId !== chatId) {
      // A different conversation opens at its latest message, however the last
      // one was left.
      seen.current = { chatId, count: messageCount };
      el.scrollTo({ top: el.scrollHeight });
      atBottomRef.current = true;
      setAtBottom(true);
      setUnseen(0);
      return;
    }
    const added = messageCount - seen.current.count;
    seen.current.count = messageCount;
    if (added <= 0) return;
    if (atBottomRef.current) scrollToLatest(true);
    else setUnseen((n) => n + added);
  }, [chatId, messageCount, scrollToLatest]);

  // The waiting row is content too: it appears under the message just sent, and
  // for a reader at the bottom it should not be the thing that is cut off.
  useEffect(() => {
    if (thinking && atBottomRef.current) scrollToLatest(false);
  }, [thinking, scrollToLatest]);

  // A question is content that arrives with no message behind it —
  // `ask_operator` writes the row mid-turn, so the card can land while the
  // thread is still thinking and `messageCount` has not moved. Same rule as the
  // waiting row above: it follows a reader who was already at the bottom and
  // moves nobody else.
  useEffect(() => {
    if (openQuestions > 0 && atBottomRef.current) scrollToLatest(false);
  }, [openQuestions, scrollToLatest]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [draft]);

  // After the insertion, not with it: the caret is a property of the DOM node
  // and the draft it belongs to has to be rendered first, or the position lands
  // in the text as it was before the name went in.
  useEffect(() => {
    if (caretTo === null) return;
    const el = composerRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(caretTo, caretTo);
    }
    setCaretTo(null);
  }, [caretTo]);

  /* ---------------------------------------------------------------- */
  /* The mention list                                                  */
  /* ---------------------------------------------------------------- */

  const ambientLine = useMemo(() => describeAmbientAgents(ambient), [ambient]);

  // An unusable agent is listed rather than hidden, marked, for the reason the
  // run form's picker lists one: it is a row the operator saved, and a registry
  // that quietly stops showing it is a registry that disagrees with the page
  // they saved it on. Mentioning one costs a refusal with a sentence naming the
  // fix, which is a better answer than an agent that appears not to exist.
  const matches = useMemo(() => {
    if (!mention || mentionClosed === mention.start) return [];
    const query = mention.query.toLowerCase();
    return agents
      .filter((a) => a.name.toLowerCase().includes(query))
      .slice(0, MENTION_LIMIT);
  }, [agents, mention, mentionClosed]);

  const mentionOpen = matches.length > 0;
  // Clamped rather than reset on every filter: the list narrows as the operator
  // types, and an index left past its end would highlight nothing while Tab
  // still had something to insert.
  const active = Math.min(mentionIndex, matches.length - 1);

  /** Read the token under the caret. Called wherever the caret can have moved. */
  const readMention = (value: string, caret: number | null) => {
    const token = caret === null ? null : mentionAt(value, caret);
    if (mention?.start === token?.start && mention?.query === token?.query) return;
    setMention(token);
    setMentionIndex(0);
  };

  const insertMention = (name: string) => {
    const el = composerRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? draft.length;
    const before = draft.slice(0, mention.start);
    // The trailing space closes the token, which is what hides the list without
    // a second piece of state deciding when it is finished.
    const inserted = `@${name} `;
    setDraft(before + inserted + draft.slice(caret));
    setMention(null);
    setMentionClosed(null);
    setCaretTo(before.length + inserted.length);
  };

  const send = async () => {
    const message = draft.trim();
    // `thinking` is checked here and not only on the button: the composer stays
    // usable while a turn runs so a reply can be written, and Enter must not
    // send into the guard that keeps one billed child per conversation.
    if (!message || !chatId || busy || thinking) return;
    setBusy(true);
    setSendError(null);
    try {
      const result = await chatRequest(`/api/chat/${chatId}/message`, { message });
      // The draft is cleared on success only. A failed send that ate the text
      // is a failure the operator cannot retry.
      if (!result.ok) setSendError(result.error ?? "The message could not be sent.");
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
    setSendError(null);
    try {
      const result = await chatRequest(`/api/chat/${chatId}/cancel`);
      if (!result.ok) setSendError(result.error ?? "The turn could not be stopped.");
      else if (result.chat) setChat(result.chat);
    } finally {
      // `send`'s reasoning, and this handler is the one that most needs it: a
      // turn worth stopping is one where something has already gone wrong.
      setBusy(false);
    }
  };

  /**
   * Answer what the chat asked, which starts the turn that reads the answer.
   *
   * Deliberately its own door rather than a composer send: the route settles
   * the rows this names and quotes each question above its answer, so the fresh
   * child resumed against the session reads what it asked rather than a bare
   * string. Sending the same words through the composer would *supersede* the
   * questions instead, which is a different fact and one the model is told.
   *
   * `busy` is shared with the composer and the approve row for the reason it
   * always was: one billed child per conversation, and every control that can
   * start one is out while a request that might have is in flight.
   */
  const answer = async (answers: Array<{ id: string; answer: string }>) => {
    if (!chatId || answers.length === 0 || busy || thinking) return;
    setBusy(true);
    setAnswerError(null);
    try {
      const result = await chatRequest(`/api/chat/${chatId}/questions`, { answers });
      if (!result.ok) {
        setAnswerError(result.error ?? "That answer could not be sent.");
      } else if (result.chat) {
        setChat(result.chat);
      }
    } finally {
      setBusy(false);
    }
  };

  const decide = async (action: "approve" | "reject", ids: string[]) => {
    if (!chatId || ids.length === 0 || busy) return;
    setBusy(true);
    setDecideError(null);
    try {
      const result = await chatRequest(`/api/chat/${chatId}/proposals`, { action, ids });
      if (!result.ok) setDecideError(result.error ?? "That could not be applied.");
      else {
        setSelected(new Set());
        if (result.chat) setChat(result.chat);
      }
    } finally {
      setBusy(false);
    }
  };

  const newChat = async () => {
    setError(null);
    try {
      const res = await fetch("/api/chat", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        chat?: ChatDTO;
        error?: string;
      };
      // Reported rather than returned from silently: a New chat button that
      // does nothing at all reads as a broken page.
      if (!res.ok || !data.chat) {
        setError(data.error ?? "A new chat could not be started.");
        return;
      }
      setChat(data.chat);
      setSelected(new Set());
      void load(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const proposals = chat?.proposals ?? [];
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");
  const allSelected = pending.length > 0 && selected.size === pending.length;
  const showJump = !atBottom && messageCount > 0;

  // Proposals is always offered, empty or not: it is what the panel is for, and
  // a tab bar that appeared only once the chat had proposed something would
  // move the other two under the reader on the first turn.
  const sideTabs: SegmentedOption<SideTab>[] = [
    { value: "proposals", label: "Proposals" },
    ...(decided.length > 0
      ? [{ value: "decided" as const, label: "Decided" }]
      : []),
    // The current thread is one of these, so a lone conversation is a list with
    // nothing to choose from — the same rule that used to hide the whole card.
    ...(chats.length > 1 ? [{ value: "chats" as const, label: "Chats" }] : []),
  ];
  // Derived rather than corrected in an effect: opening a thread with nothing
  // decided while the Decided tab is selected must fall back on the render that
  // drops the tab, not one frame later.
  const activeSide = sideTabs.some((t) => t.value === side) ? side : "proposals";
  const waitingBadge = pending.length > 0 && (
    <Badge tone="accent">{pending.length} waiting</Badge>
  );

  const lastMessage = messageCount > 0 ? chat?.messages[messageCount - 1] : undefined;
  // A turn that ends badly is written to the row *and* appended to the thread,
  // so rendering both says it twice. This is the belt for the case where only
  // the row carries it — and it belongs at the end of the conversation, where
  // the turn failed, rather than at the top of the page.
  const turnFailure =
    chat?.status === "failed" && chat.error && chat.error !== lastMessage?.text
      ? chat.error
      : null;
  // The turn started when the message it is answering was written.
  const waitingSince = lastMessage?.ts ?? chat?.updatedAt ?? Date.now();

  // What the click does, counted, above the button that does it. "Approve"
  // alone is a word; this is the sentence a person needs before pressing it.
  //
  // The two kinds are counted apart rather than summed, because approving them
  // does two different things and only one of them spends money: a run
  // proposal starts an unattended agent, a workflow proposal *saves a graph*
  // and starts nothing. A single sentence over both would have to be true of
  // the stronger one, which would claim four agents are about to work when
  // three of the four selections were workflows.
  const chosen = pending.filter((p) => selected.has(p.id));
  const runCount = chosen.filter((p) => p.kind === "run").length;
  const graphCount = chosen.length - runCount;
  const approveConsequence =
    chosen.length === 0
      ? "Approving starts each run under the guards shown on it, and saves each workflow without starting it."
      : [
          runCount === 1
            ? "Approve starts one unattended run that spends real money, under the guards shown on it."
            : runCount > 1
              ? `Approve starts ${runCount} unattended runs that spend real money, under the guards shown on each.`
              : "",
          graphCount === 1
            ? "It saves one workflow without starting it — press Run on the workflow itself when you want it."
            : graphCount > 1
              ? `It saves ${graphCount} workflows without starting them — press Run on each when you want it.`
              : "",
        ]
          .filter(Boolean)
          .join(" ");

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
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Orchestrator</h1>
        <div className="ml-auto flex items-center gap-3">
          {chat && chat.costUSD > 0 && (
            <span className="text-xs tabular-nums text-ink-muted">
              {fmtUSD(chat.costUSD)} this chat
            </span>
          )}
          <Button variant="secondary" onClick={() => void newChat()}>
            New chat
          </Button>
        </div>
      </div>

      {/* Two paragraphs of standing context stood between the heading and a box
          that fills what is left of the pane, and everything they cost came off
          the box — which is how the composer at the foot of it ended up under
          the fold on a short window. What stays visible is the sentence that
          has to be read before anything on this page is pressed: hiding *that*
          would be trading a safety claim for a few lines of room, and the rule
          is that a disclosure holds what some readers need rather than what all
          of them do. The rest is read once, and is a press away with its
          subject named on the summary. */}
      <Notice tone="info" quiet>
        <p>
          <strong>Nothing here starts a run.</strong> Each proposal waits for
          you, and then runs under the guards of the template it names — never
          under anything the chat chose.
        </p>
        <Disclosure
          className="mt-1.5"
          summary="What the chat itself may do, and what its turns cost"
        >
          <p className="mt-2">
            A proposal that names no template runs under the default guard set
            in <Link href="/settings">Settings</Link>.
          </p>
          <p className="mt-2">
            The chat itself runs with no tool restrictions, so it can read, run
            commands and reach GitHub while it works out what to propose; the
            instruction not to do the work, rather than a permission mode, is
            what keeps it out of your checkouts. Its turns spend against the
            same 5-hour window as everything else, and that cost is shown here
            only — never added to a run&rsquo;s, or to the dashboard meters.
          </p>
        </Disclosure>
      </Notice>

      {pollError && <Notice tone="danger">{pollError}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}

      {/* Fills what is left of the pane rather than taking 68vh of the window,
          which is a taller box than the pane it sits in — the composer went
          under the fold and the page grew a second scrollbar behind a thread
          that was already scrolling itself.

          Only at `lg`, where the proposals sit *beside* the thread. Stacked
          under it there is a second column of content below the fold and the
          page is meant to scroll, so the card stays a bounded box there.

          The floor is 22rem rather than 26: a minimum is the one thing here
          that can still push the composer out of the pane, and it does it on
          exactly the short window that can least afford it. Below the floor the
          thread is small; past it the page scrolls again. */}
      <div className="grid gap-4 lg:min-h-[22rem] lg:flex-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* `max-h` in rem and not vh, for the reason a box inside the pane is
            never sized in viewport units: the pane is the window less the
            toolbar less its own padding less everything above this row, so
            60vh was a cap that could sit either side of the edge depending on
            the window and never on the box it was capping. */}
        <Card
          emphasis="default"
          className="flex max-h-[34rem] min-h-[22rem] flex-col lg:max-h-none lg:min-h-0"
        >
          <div className="relative min-h-0 flex-1">
            <div ref={threadRef} onScroll={onScroll} className="h-full overflow-y-auto pr-1">
              {/* `additions` only: the waiting row's elapsed time changes every
                  second inside this region, and the default `additions text`
                  would read the whole thing out again each time. */}
              <div
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label="Conversation"
                className="flex flex-col"
              >
                {chat === null ? (
                  <div className="py-10 text-center text-sm text-ink-muted">
                    {pollError ? "The conversation could not be loaded." : "Loading…"}
                  </div>
                ) : messageCount === 0 ? (
                  <div className="px-2 py-10 text-center">
                    <p className="text-sm text-ink">Nothing asked yet</p>
                    <p className="mx-auto mt-1 max-w-[46ch] text-xs leading-normal text-ink-muted">
                      Ask it to look at something — &ldquo;check the open issues
                      on usagefoundry and propose a run for each bug&rdquo;.
                    </p>
                  </div>
                ) : (
                  items.map((item, i) => {
                    if (item.kind === "questions") {
                      return (
                        <AskedQuestions
                          // The set as asked, so an operator part-way through
                          // typing an answer keeps it across a poll — the ids
                          // do not change when a sibling is answered.
                          key={item.questions[0].id}
                          questions={item.questions}
                          busy={busy}
                          thinking={thinking}
                          error={answerError}
                          onAnswer={(answers) => void answer(answers)}
                        />
                      );
                    }
                    // Read off the *item* before it and not the message before
                    // it: a question card between two turns of one speaker
                    // means they are no longer one utterance, so the second one
                    // gets its name and its time back.
                    const prev = items[i - 1];
                    return (
                      <Message
                        key={item.message.id}
                        message={item.message}
                        grouped={
                          prev?.kind === "message" &&
                          prev.message.role === item.message.role
                        }
                      />
                    );
                  })
                )}

                {thinking && <Waiting since={waitingSince} stale={pollError !== null} />}

                {turnFailure && (
                  <div className="mt-5 max-w-[70ch] rounded-sm border-l-2 border-l-danger bg-inset px-3 py-2 text-xs leading-normal text-danger">
                    {turnFailure}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => scrollToLatest(true)}
              aria-hidden={!showJump}
              tabIndex={showJump ? 0 : -1}
              className={`absolute right-3 bottom-3 flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-xs font-medium text-ink shadow-e2 transition duration-[var(--motion-base)] ease-standard hover:border-ink-faint ${
                JUMP_STATE[showJump ? "shown" : "hidden"]
              }`}
            >
              <Icon name="chevron-down" size="sm" />
              {unseen > 0 ? `${unseen} new` : "Latest"}
            </button>
          </div>

          {/* Pinned to the foot of the pane: the card is a flex column and the
              thread above it is the only thing that scrolls, so the composer
              stays where the hand expects it however long the conversation
              gets. */}
          <div className="relative mt-4 border-t border-line pt-4">
            {mentionOpen && (
              // Above the composer, because the composer is at the foot of the
              // pane. `mousedown` rather than `click` on a row, with the
              // default prevented: a click would blur the textarea first, and
              // the insertion needs the caret it is about to move.
              <div className="absolute bottom-full left-0 z-10 mb-1 w-80 max-w-full overflow-hidden rounded-lg border border-line bg-surface shadow-e2">
                <ul id="agent-mentions" role="listbox" aria-label="Saved agents" className="py-1">
                  {matches.map((a, i) => (
                    <li
                      key={a.id}
                      id={`agent-mention-${a.id}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(a.name);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                      className={`cursor-pointer px-2.5 py-1.5 ${
                        MENTION_ROW[i === active ? "active" : "idle"]
                      }`}
                    >
                      <span className="block truncate text-xs font-medium text-ink">
                        {a.name}
                        {!a.usable && (
                          <span className="ml-1.5 font-normal text-danger">
                            incomplete
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-2xs text-ink-muted">
                        {a.description}
                      </span>
                    </li>
                  ))}
                </ul>
                {/* Enter is named here because it is the one thing about this
                    list that would otherwise be found out by losing a message:
                    it sends, exactly as it does with the list shut. */}
                <div className="border-t border-line px-2.5 py-1.5 text-2xs text-ink-faint">
                  Tab inserts · Enter still sends
                  {ambientLine && <span className="mt-0.5 block">{ambientLine}</span>}
                </div>
              </div>
            )}
            <textarea
              ref={composerRef}
              aria-label="Message the orchestrator"
              aria-autocomplete="list"
              aria-expanded={mentionOpen}
              aria-controls={mentionOpen ? "agent-mentions" : undefined}
              aria-activedescendant={
                mentionOpen && matches[active]
                  ? `agent-mention-${matches[active].id}`
                  : undefined
              }
              // No focus ring of its own. @layer base draws one halo for every
              // focusable thing in the app, and the `outline-none` plus 3px
              // box-shadow that used to be here was the second treatment that
              // rule exists to have none of.
              //
              // `max-md:text-[16px]` for the reason CONTROL_BASE in ui/Field
              // states it: under 16px iOS Safari zooms the page in on focus and
              // never zooms back out. This is the one text control in the app
              // written by hand rather than taken from the kit, so it is the
              // one that has to repeat it.
              className="ui-transition min-h-[4.5rem] w-full resize-none overflow-y-auto rounded-sm border border-line bg-inset px-3 py-2.5 font-sans text-sm max-md:text-[16px] leading-normal text-ink placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
              rows={3}
              placeholder="Ask the orchestrator to look at something and propose runs…"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                readMention(e.target.value, e.target.selectionStart);
              }}
              // Caret moves that are not edits — a click, Home, an arrow key —
              // change which token is under it, so the list has to be read
              // there too or it survives the caret leaving the mention.
              onSelect={(e) =>
                readMention(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                )
              }
              // Not on blur alone: a row's `mousedown` prevents the blur, so
              // this only fires when focus really has left the composer.
              onBlur={() => setMention(null)}
              onKeyDown={(e) => {
                // The mention list gets the keys nothing else here claims, and
                // **never Enter or ⌘↩**. That is the whole rule: this composer
                // sends on Enter, so a list that accepted a completion with it
                // would swallow the send whenever the operator happened to be
                // at the end of a name — which is exactly when they are most
                // likely to be finished. Tab inserts instead, the popover says
                // so, and the send chords fall through untouched below.
                //
                // Skipped entirely mid-composition: an IME owns the keyboard
                // while a candidate is up, and a layer that took Tab or the
                // arrows from it would break the candidate list rather than
                // this one.
                if (mentionOpen && !e.nativeEvent.isComposing) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIndex((active + 1) % matches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIndex((active - 1 + matches.length) % matches.length);
                    return;
                  }
                  if (e.key === "Tab" && !e.shiftKey) {
                    e.preventDefault();
                    insertMention(matches[active].name);
                    return;
                  }
                  if (e.key === "Escape") {
                    // Dismissed for this token only, so typing more of the
                    // name does not reopen what was just shut. Consumed,
                    // because closing the list is what Esc means here — the
                    // shell binds it to nothing and there is no dialog under
                    // this to fall through to.
                    e.preventDefault();
                    setMentionClosed(mention?.start ?? null);
                    return;
                  }
                }
                // Two ways to send and one of them is the platform's. ⌘↩ is the
                // commit chord this app already uses on the run form, and the
                // shell's keyboard layer deliberately binds it to nothing so a
                // field's own can never be swallowed. Enter stays, because it is
                // what a conversation is typed with everywhere else.
                //
                // `isComposing` is the one that is not obvious: an IME takes
                // Enter to accept the candidate it is showing, and sending there
                // posts half a word. It cannot apply to ⌘↩, which is why that
                // branch is tested first.
                if (e.key !== "Enter") return;
                if (e.metaKey) {
                  e.preventDefault();
                  void send();
                  return;
                }
                if (e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                void send();
              }}
            />
            <ButtonRow className="mt-2">
              {/* The composer is deliberately *not* disabled or pre-filled
                  while a question is open: the chat is `idle`, there is no
                  child, and the operator may say anything they like. What it
                  owes them is what saying it does — an ordinary message is the
                  operator declining and redirecting, and the server closes
                  every open question as overtaken in the same statement that
                  records it. Left unsaid, a question answered in prose here
                  reads as still waiting, and the card stays clickable a week
                  later to start a billed turn about a conversation nothing in
                  the thread is about any more. */}
              <span className="mr-auto text-xs text-ink-faint">
                {thinking
                  ? "Stop ends this turn and signals the process answering it"
                  : openQuestions > 0
                    ? `Answer above, or send a message — sending closes the ${
                        openQuestions === 1 ? "question" : "questions"
                      } as overtaken`
                    : "⌘↩ or Enter sends · Shift+Enter for a new line"}
              </span>
              {thinking && (
                <Button variant="secondary" disabled={busy} onClick={() => void stop()}>
                  Stop
                </Button>
              )}
              <Button
                onClick={() => void send()}
                disabled={thinking || busy || !draft.trim()}
                aria-keyshortcuts="Meta+Enter"
              >
                Send
                <span aria-hidden="true" className="text-xs opacity-70">
                  ⌘↩
                </span>
              </Button>
            </ButtonRow>
            {sendError && <Hint tone="danger">{sendError}</Hint>}
          </div>
        </Card>

        {/* One box the height of the row, holding one list at a time. Three
            stacked cards each grew without limit, so the column was taller than
            the pane whatever the pane did — and the two lists nobody is acting
            on were what you scrolled past to reach the one you were.

            The card is the scroll container's parent rather than the scroll
            container: what scrolls is the list, so the tab bar stays on screen
            and so does the row that approves things. */}
        <Card
          emphasis={PROPOSALS_EMPHASIS[pending.length > 0 ? "waiting" : "clear"]}
          className="flex max-h-[34rem] flex-col lg:max-h-none lg:min-h-0"
        >
          {/* A radiogroup with one option is a chip that does nothing, which is
              what a fresh install would open on — so until there is a second
              list to reach, this is the title it always was.

              The count sits beside the control rather than on the Proposals
              segment either way: a number only visible from the tab it belongs
              to is one nobody reads from the other two, and this is the one on
              the page that means somebody is waiting on a decision. */}
          {sideTabs.length > 1 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <SegmentedControl
                label="What to show beside the conversation"
                options={sideTabs}
                value={activeSide}
                onChange={setSide}
              />
              {waitingBadge}
            </div>
          ) : (
            <CardTitle>
              Proposals
              {waitingBadge}
            </CardTitle>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {activeSide === "proposals" &&
              (pending.length === 0 ? (
                <Empty>Nothing waiting for approval.</Empty>
              ) : (
                // One grouped box, hairlines between the rows: a proposal is an
                // object in a list of objects, and the stack of separately
                // bordered cards this replaces read as five unrelated panels in
                // a 360px column.
                <ListGroup>
                  {pending.map((p) => (
                    <Proposal
                      key={p.id}
                      proposal={p}
                      checked={selected.has(p.id)}
                      onToggle={() => toggle(p.id)}
                    />
                  ))}
                </ListGroup>
              ))}

            {activeSide === "decided" && (
              <div className="flex flex-col divide-y divide-line">
                {decided
                  .slice()
                  .reverse()
                  .map((p) => (
                    <Decided key={p.id} proposal={p} />
                  ))}
              </div>
            )}

            {/* The current thread is in this list rather than filtered out of
                it, because "which one am I in" is the first thing the list has
                to answer and a row missing from a list cannot answer it. */}
            {activeSide === "chats" && (
              <div className="flex flex-col gap-0.5">
                {chats.map((c) => (
                  <ChatRow
                    key={c.id}
                    entry={c}
                    current={c.id === chatId}
                    onOpen={() => {
                      // Ticked ids belong to the thread they were ticked in.
                      // `newChat` clears them for the same reason; carried
                      // over, they describe proposals not on screen and are
                      // sent to a chat that has never held them.
                      setSelected(new Set());
                      setDecideError(null);
                      // Same rule: a refusal names a question of the thread
                      // being left, and carried over it annotates a card in a
                      // conversation it was never about.
                      setAnswerError(null);
                      void load(c.id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Outside the scroll region: what the click starts, counted, has to
              be on screen beside the button that starts it — a twentieth
              proposal must not push the sentence off the top of the list it is
              about. */}
          {activeSide === "proposals" && pending.length > 0 && (
            <div className="mt-3 shrink-0 border-t border-line pt-3">
              <Hint>
                {approveConsequence} Runs beyond the concurrency limit queue
                rather than being refused.
              </Hint>
              {/* The default action at the right edge, which is where this
                  platform puts it and where every sheet in this app already
                  puts it. Select all is not a decision about the work, so it
                  sits at the other end as a ghost. */}
              <ButtonRow className="mt-3">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setSelected(
                      allSelected ? new Set() : new Set(pending.map((p) => p.id)),
                    )
                  }
                >
                  {allSelected ? "Select none" : "Select all"}
                </Button>
                <Button
                  variant="secondary"
                  className="ml-auto"
                  disabled={busy || selected.size === 0}
                  onClick={() => void decide("reject", [...selected])}
                >
                  Reject
                </Button>
                <Button
                  disabled={busy || selected.size === 0}
                  onClick={() => void decide("approve", [...selected])}
                >
                  {selected.size > 0 ? `Approve ${selected.size}` : "Approve"}
                </Button>
              </ButtonRow>
              {decideError && <Hint tone="danger">{decideError}</Hint>}
            </div>
          )}
        </Card>
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
 *
 * **Who is speaking is carried by structure, not by colour.** The answer is the
 * pane: plain prose at a readable measure, with nothing drawn round it, because
 * it is what the reader came for. The operator's own words are a bezelled block
 * pulled to the right — a raised chip on a neutral surface, the same treatment
 * every other secondary control in this app wears. It used to be an
 * accent-tinted bubble, which is the web-chat idiom and which spent the app's
 * one accent on saying "a human typed this" — a fact the position and the label
 * already carry, and one that never needs the emphasis a tint claims for it.
 *
 * Only the first turn of a run gets a name and a time: consecutive turns from
 * one speaker are one utterance interrupted by a newline, and repeating the
 * label says nothing.
 */
function Message({ message, grouped }: { message: ChatMessageDTO; grouped: boolean }) {
  const { role, text, ts } = message;

  if (role === "system") {
    return (
      // The kit's quiet notice, in the thread's own rhythm: a hairline box with
      // a neutral leading edge. Not a `Notice`, only because that component
      // carries a margin of its own that would fight the run spacing here.
      <div
        className={`${
          grouped ? "mt-1.5" : "mt-5"
        } max-w-[70ch] rounded-sm border border-line border-l-[3px] border-l-line-strong bg-inset px-3 py-2 text-xs leading-normal text-ink-muted first:mt-0`}
      >
        {text}
      </div>
    );
  }

  if (role === "assistant") {
    return (
      <div className={`${grouped ? "mt-2.5" : "mt-5"} max-w-[70ch] first:mt-0`}>
        {!grouped && <Speaker name="Orchestrator" ts={ts} />}
        {/* Markdown for the model's half only. The operator's own text is left
            exactly as typed — an asterisk they meant is not emphasis. */}
        <Markdown text={text} />
      </div>
    );
  }

  return (
    <div
      className={`${grouped ? "mt-1.5" : "mt-5"} flex flex-col items-end first:mt-0`}
    >
      {!grouped && <Speaker name="You" ts={ts} />}
      <div className="max-w-[85%] rounded-lg border border-line bg-bezel px-3 py-2 text-sm leading-normal whitespace-pre-wrap text-ink shadow-e1 [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  );
}

/**
 * Who, and when.
 *
 * Sentence case at a weight step rather than 11px uppercase with tracking — the
 * same correction `CardTitle` documents. macOS does not shout a label, and a
 * conversation is the last place to start.
 */
function Speaker({ name, ts }: { name: string; ts: number }) {
  return (
    <div className="mb-1 flex items-baseline gap-2 text-xs">
      <span className="font-semibold text-ink">{name}</span>
      <time
        dateTime={new Date(ts).toISOString()}
        title={fmtDateTime(ts)}
        className="tabular-nums text-ink-faint"
      >
        {fmtRelative(ts)}
      </time>
    </div>
  );
}

/**
 * The wait between sending and the first word.
 *
 * Legible frozen, which is the whole constraint: `@layer base` flattens every
 * animation to one frame under `prefers-reduced-motion`, so a busy state that
 * only exists while it moves is a busy state half the operators never see. What
 * says "working" here is a word, a ring and a clock — the ring stops turning
 * and the other two are unaffected. Nothing claims to know how far through the
 * turn is, because nothing does; the elapsed time is the only real progress
 * there is, and a bar would be an invention.
 *
 * `role="status"` holds the word alone — the clock beside it is hidden from
 * assistive tech, or the turn would be announced once a second.
 */
function Waiting({ since, stale }: { since: number; stale: boolean }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  // `thinking` is only ever as fresh as the last poll that worked, so once one
  // has failed this may no longer be true.
  if (stale) {
    return (
      <div className="mt-5 max-w-[70ch] text-xs leading-normal text-warn">
        Was thinking when the last refresh failed — state unknown.
      </div>
    );
  }

  return (
    <div className="mt-5 flex items-center gap-2">
      <Spinner />
      <span role="status" className="text-xs font-medium text-ink-muted">
        Thinking…
      </span>
      <span aria-hidden="true" className="text-2xs tabular-nums text-ink-faint">
        {fmtDuration(Math.max(0, now - since))}
      </span>
    </div>
  );
}

/**
 * What the chat asked the operator, and what became of it.
 *
 * **It is in the transcript rather than in the panel beside it, and that is the
 * split this page is built on.** The right-hand list is work waiting to be
 * approved and costs nothing until a person clicks; a question is a sentence,
 * answering it starts a chat turn, and it belongs in the half of the page where
 * the other sentences are. It is drawn as an object for `Proposal`'s reason —
 * it has controls on it — but it is deliberately not a `Card`: `emphasis`
 * carries padding as well as elevation, and this box is inside the scrolled
 * conversation, which is the one region on this page that must not re-pad
 * itself under a reader's hands while it polls.
 *
 * **A settled question stays.** Answered or overtaken, it keeps its place above
 * the message that settled it, because a card that disappeared when it was
 * answered reads as a question nobody was ever asked — and the message beside
 * it, which quotes each question above its answer, then reads as text that
 * arrived from nowhere. `superseded` is drawn as neither a failure nor an
 * answer: the operator said something else, which *is* an answer, and drawing
 * it in danger red would report a redirection as a fault.
 *
 * **When a click sends, and when it only fills something in.** A choice sends
 * on one press whenever it is the last question open — that is the whole point
 * of offering buttons, and with nothing else open there is nothing the send can
 * take with it. With siblings still open it cannot, because the answer message
 * settles the set and supersedes whatever it did not name: one hasty press
 * would close two questions the operator was still reading. So above one, the
 * choices fill in and the row's own button sends them together, and the card
 * says as much rather than leaving it to be found out.
 */
function AskedQuestions({
  questions,
  busy,
  thinking,
  error,
  onAnswer,
}: {
  questions: ChatQuestionDTO[];
  busy: boolean;
  thinking: boolean;
  error: string | null;
  onAnswer: (answers: Array<{ id: string; answer: string }>) => void;
}) {
  // Keyed by question id and local to the card, so a poll landing mid-sentence
  // re-renders around the draft rather than through it.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const open = questions.filter((q) => q.status === "pending");
  // Out while a turn is in flight, and said in words below. `sendChatMessage`
  // refuses a second billed child on one conversation, so a press here during a
  // turn is a refusal — and a question can be open while its own turn is still
  // running, since `ask_operator` records the row and returns rather than
  // blocking on the click.
  const disabled = busy || thinking;

  const submit = (override?: { id: string; answer: string }) => {
    const answers = open.flatMap((q) => {
      const value = (
        override?.id === q.id ? override.answer : (drafts[q.id] ?? "")
      ).trim();
      return value ? [{ id: q.id, answer: value }] : [];
    });
    if (answers.length === 0) return;
    onAnswer(answers);
  };

  const choose = (id: string, choice: string) => {
    if (open.length === 1) {
      submit({ id, answer: choice });
      return;
    }
    setDrafts((d) => ({ ...d, [id]: choice }));
  };

  // Nothing to press it with where every open question is a shortlist and there
  // is only one of them — the choices are the button, and a second one that
  // never has anything to send is a control that reads as broken.
  const sends = open.length > 1 || open.some((q) => q.allowText);
  const ready = open.some((q) => (drafts[q.id] ?? "").trim().length > 0);

  return (
    <div
      className={`mt-5 max-w-[70ch] rounded-sm border border-line border-l-[3px] bg-inset px-3 py-2.5 first:mt-0 ${
        QUESTION_EDGE[open.length > 0 ? "open" : "settled"]
      }`}
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold text-ink">
          {open.length > 0 ? "Waiting on you" : "Asked you"}
        </span>
        {open.length > 1 && (
          <span className="text-2xs text-ink-muted">
            {open.length} questions, answered together — anything left blank is
            sent as not answered
          </span>
        )}
      </div>

      {/* Hairlines between them, `Decided`'s construction one card over. A
          question with a text field under it and the next question's sentence
          below that is three blocks at one spacing, and the field then reads as
          belonging to whichever of the two the eye reached first — which is a
          typed answer filed against the wrong question. A rule is what says
          where one decision ends. It costs nothing with a single question,
          which is the common case: `divide-y` draws between siblings. */}
      <div className="flex flex-col divide-y divide-line">
        {questions.map((q) => (
          <div key={q.id} className="py-3 first:pt-0 last:pb-0">
            <p className="text-sm leading-normal text-ink">{q.question}</p>

            {q.status === "answered" && (
              <p className="mt-1 text-xs leading-normal text-ink-muted">
                You answered{" "}
                <span className="font-medium text-ink">{q.answer}</span>
              </p>
            )}
            {q.status === "superseded" && (
              <p className="mt-1 text-xs leading-normal text-ink-muted">
                Overtaken by what you said next.
              </p>
            )}

            {q.status === "pending" && (
              <>
                {q.choices.length > 0 && (
                  <ButtonRow className="mt-2">
                    {q.choices.map((choice) => (
                      <Button
                        key={choice}
                        size="compact"
                        variant={
                          CHOICE_VARIANT[
                            drafts[q.id] === choice ? "chosen" : "offered"
                          ]
                        }
                        // A toggle only where it is one. With this the last open
                        // question, the press is the answer and announcing it as
                        // pressed would describe a control that is already gone.
                        aria-pressed={
                          open.length > 1 ? drafts[q.id] === choice : undefined
                        }
                        disabled={disabled}
                        onClick={() => choose(q.id, choice)}
                      >
                        {choice}
                      </Button>
                    ))}
                  </ButtonRow>
                )}

                {q.allowText && (
                  // A kit control, not a hand-written one: below `md`, iOS Safari
                  // zooms the page in on any text control under 16px and never
                  // zooms back out, and `Input` is where that floor lives. The
                  // composer is this app's one hand-written exception and is not
                  // a precedent for a second.
                  <Input
                    className="mt-2"
                    aria-label={q.question}
                    placeholder={
                      q.choices.length > 0 ? "…or type an answer" : "Your answer"
                    }
                    value={drafts[q.id] ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [q.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      // The composer's chord, in the one other field on this page
                      // that sends. No Shift+Enter branch: this is a single-line
                      // input and there is no newline to make.
                      if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                      e.preventDefault();
                      if (!disabled) submit();
                    }}
                  />
                )}

                {q.choices.length === 0 && !q.allowText && (
                  // Reachable rather than theoretical: `questionChoices` answers
                  // an unreadable `choices` column with none, which is the
                  // reading that fails safe — and it leaves a question with
                  // nothing on it to press. Said, because the way out is a
                  // different control on a different part of the page.
                  <p className="mt-1 text-2xs leading-normal text-warn">
                    This question offers nothing to press and no way to type an
                    answer. Reply in the composer instead, which closes it.
                  </p>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {open.length > 0 && (
        <>
          {sends && (
            <ButtonRow className="mt-3">
              <Button
                size="compact"
                disabled={disabled || !ready}
                onClick={() => submit()}
              >
                {open.length > 1 ? `Answer ${open.length}` : "Answer"}
              </Button>
            </ButtonRow>
          )}
          {thinking && (
            <p className="mt-2 text-2xs leading-normal text-ink-faint">
              This turn is still working — you can answer once it finishes.
            </p>
          )}
          {/* Inside the open branch, because the page holds one answer error
              and every question card in the thread is handed it. Drawn
              unconditionally, a refusal would also appear under every settled
              pair further up — a sentence about a press, against a question
              decided last week. */}
          {error && <Hint tone="danger">{error}</Hint>}
        </>
      )}
    </div>
  );
}

/**
 * A proposal waiting on a decision.
 *
 * Drawn as an object rather than as text: it names a folder and a guard set,
 * and approving it starts an unattended agent that spends real money in that
 * folder. The two facts that decide the answer — where, and under whose rules —
 * are the last line, each behind its own mark so they cannot be read as one
 * string.
 */
function Proposal({
  proposal,
  checked,
  onToggle,
}: {
  proposal: ChatProposalDTO;
  checked: boolean;
  onToggle: () => void;
}) {
  const workflow = proposal.kind === "workflow";
  const missing = proposal.guardsSource === "missing";
  const folder = proposal.folderLabel ?? "folder from the template";

  return (
    <label
      // `mb-0 font-normal` for the same reason ChatRow names a background: the
      // legacy sheet still gives every `label` a bottom margin and 500 weight.
      // The end rows take the group's corners, because the wash would otherwise
      // square off a box that `ListGroup` deliberately does not clip.
      className={`ui-transition mb-0 flex cursor-pointer gap-2.5 p-3 font-normal first:rounded-t-lg last:rounded-b-lg ${
        PROPOSAL_ROW[checked ? "selected" : "idle"]
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Select “${proposal.title}”`}
        className="mt-0.5 size-4 shrink-0 accent-tint"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-sm leading-snug font-semibold text-ink">
            {proposal.title}
          </div>
          {workflow && <Badge tone="neutral">workflow</Badge>}
        </div>
        <p className="mt-1 line-clamp-3 text-xs leading-normal text-ink-muted">
          {proposal.task}
        </p>

        {workflow ? (
          <ProposedGraph proposal={proposal} />
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
            <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={folder}>
              <Icon name="folder" size="sm" />
              <span className="truncate">{folder}</span>
            </span>
            {/* The one fact in this row that wraps rather than truncating, and
                the folder beside it is why the difference is worth stating: a
                press of Approve is approved against this guard set, so it is a
                fact a decision is taken on — visible with no interaction, and
                a hover title is not a way of reading it at all on touch. The
                row already wraps, so the whole set costs a second line and
                moves nothing. A folder path is context and may still be
                clipped. */}
            <span
              className={`inline-flex min-w-0 max-w-full items-center gap-1 ${
                GUARD_TONE[missing ? "missing" : "set"]
              }`}
            >
              <Icon name="guard" size="sm" />
              <span>{missing ? "template deleted" : proposal.guardsLabel}</span>
            </span>
            {/* Outside the guard mark and never inside it. The agent is what
                the run will be *started as*, which is a larger fact than the
                delegation this used to name — and still not a guard: it carries
                no tool list and no permission mode, so a phrase under the
                shield would claim it bounds something. */}
            {(proposal.agentName || proposal.agentMissing) && (
              <span
                className={`inline-flex min-w-0 max-w-full items-center gap-1 ${
                  GUARD_TONE[proposal.agentMissing ? "missing" : "set"]
                }`}
              >
                {/* Its own glyph, and emphatically not the guard's. The row
                    read icon, icon, bare text — so the two facts that carry a
                    mark looked like the row and this one looked like a
                    remainder. `agents` is the pane's own glyph, which is where
                    a definition for this name would be found. */}
                <Icon name="agents" size="sm" />
                <span className="truncate">
                  {proposal.agentName
                    ? `as ${proposal.agentName}`
                    : "agent deleted"}
                </span>
              </span>
            )}
            {/* The model rewrote the operator's own words, and this said so in
                the same muted grey as the folder beside it — the least visible
                fact on the card and the one a person is most likely to want
                back. Toned and weighted rather than given a glyph: `IconName`
                is a closed union with no warning or edit mark in it, and the
                shield is ruled out for the reason the agent phrase above is
                kept outside it. The text is unchanged and stays in this row. */}
            {proposal.promptRewritten && (
              <span className="font-medium text-warn">prompt rewritten</span>
            )}
          </div>
        )}

        {/* Shown rather than only acted on: a dependency that did not survive
            approval reads exactly like one that was never asked for, and the
            two agents then work in the same checkout in whatever order the
            queue felt like. It also says the thing the operator has to *do* —
            tick both, or the later one is failed by name. */}
        {proposal.dependsOn.length > 0 && (
          <p className="mt-2 text-2xs leading-normal text-ink-muted">
            Starts after{" "}
            {proposal.dependsOn.map((d, i) => (
              <span key={d.label}>
                {i > 0 && " and "}
                <span className="mono">{d.label}</span>
                {d.edge === "on-success" ? " (only if it succeeds)" : " (either way)"}
                {d.continueBranch && ", on its branch"}
              </span>
            ))}
            . Approve them together, or this one is not started.
          </p>
        )}

        {missing && !workflow && (
          <p className="mt-2 text-2xs leading-normal font-medium text-danger">
            The template this names has been deleted, so approving it will be
            refused.
          </p>
        )}

        {/* Said in full rather than left to the mark above, because the two
            ways of being unusable read differently and only one of them is
            about deletion: an agent missing its description or its prompt is
            one Claude Code will not register, so a run started as it would
            fail the moment it spawned. */}
        {proposal.agentMissing && !workflow && (
          <p className="mt-2 text-2xs leading-normal font-medium text-danger">
            {proposal.agentName
              ? `The “${proposal.agentName}” agent is missing its description or its prompt, so approving this will be refused.`
              : "The agent this names has been deleted, so approving it will be refused."}
          </p>
        )}
      </div>
    </label>
  );
}

/**
 * A proposed workflow's blocks, and what approving it does.
 *
 * Every guard-shaped fact on one line per block, for the reason the run card
 * carries a folder and a guard set: this is a graph a *model* wrote, and the
 * argument that lets an orchestrator block start agents with nobody looking is
 * that a person fixed its folder, its guard set and its fan-out cap. Approving
 * this card is where that person does the fixing, so the numbers have to be on
 * it — a card that said "a workflow of 5 blocks" would move the decision to a
 * canvas the operator may never open.
 *
 * The sentence about saving leads rather than trails, because it is the one
 * thing that makes approving this different from approving everything else in
 * this panel.
 */
function ProposedGraph({ proposal }: { proposal: ChatProposalDTO }) {
  const fanOut = proposal.blocks.reduce((n, b) => n + (b.fanOut ?? 0), 0);
  const paying = proposal.blocks.some((b) => b.mergeAutoResolve);

  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-2xs leading-normal text-ink-muted">
        Approving <strong className="font-semibold text-ink">saves</strong> this
        workflow and starts nothing. You press Run on it yourself, and it has no
        workflow-wide budget until you set one — so it cannot be scheduled yet.
      </p>

      {proposal.blocks.length === 0 ? (
        <Hint tone="danger">
          This proposal&rsquo;s graph could not be read, so approving it will be
          refused.
        </Hint>
      ) : (
        <ol className="flex flex-col gap-1 border-l border-line pl-2.5">
          {/* Keyed by position, which is the stable identity here: this list is
              a render of a frozen graph on a decided-or-pending row, so it never
              reorders — and two blocks may legitimately share a name, which the
              node ids this list does not carry are what keep apart. */}
          {proposal.blocks.map((b, i) => (
            <li key={i} className="text-2xs leading-normal text-ink-muted">
              <span className="font-semibold text-ink">{b.name}</span>
              <span className="text-ink-muted"> · {BLOCK_KIND[b.kind]}</span>
              {b.folderLabel && (
                <>
                  {" · "}
                  <span className="mono">{b.folderLabel}</span>
                </>
              )}
              <span
                className={b.guardsLabel === "template deleted" ? "text-danger" : ""}
              >
                {" · "}
                {b.guardsLabel}
              </span>
              {/* Its own clause, outside the guard one, for the reason the run
                  card's is: an agent decides what the block's child *is* and
                  never what it may do. */}
              {b.agentLabel && (
                <span
                  className={b.agentLabel === "agent deleted" ? "text-danger" : ""}
                >
                  {" · as "}
                  {b.agentLabel}
                </span>
              )}
              {b.fanOut !== null && (
                <span className="text-warn"> · up to {b.fanOut} run(s), no approval</span>
              )}
              {b.mergeAutoResolve && (
                <span className="text-warn"> · may pay to resolve conflicts</span>
              )}
              {b.after.length > 0 && <> · after {b.after.join(", ")}</>}
            </li>
          ))}
        </ol>
      )}

      {(fanOut > 0 || paying) && (
        <p className="text-2xs leading-normal font-medium text-warn">
          {fanOut > 0 &&
            `Each press of Run may start up to ${fanOut} run(s) that nobody approves individually.`}
          {fanOut > 0 && paying && " "}
          {paying && "A merge block may pay a model to reconcile a conflict."}
        </p>
      )}
    </div>
  );
}

/** What happened to a proposal, and no buttons: it is not a decision any more. */
function Decided({ proposal }: { proposal: ChatProposalDTO }) {
  // A workflow proposal settles onto a workflow, never a run, so the link goes
  // where the thing it made actually is — and where the press of Run it still
  // needs lives. Reading it off `runId` would leave an approved graph as the
  // one decided row with nothing to click.
  const href = proposal.runId
    ? `/runs/${proposal.runId}`
    : proposal.workflowId
      ? `/workflows/${proposal.workflowId}`
      : null;

  return (
    <div className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
      <Badge tone={PROPOSAL_TONE[proposal.status]}>{proposal.status}</Badge>
      <div className="min-w-0 flex-1">
        {href ? (
          <Link
            href={href}
            title={proposal.title}
            className="block truncate text-xs"
          >
            {proposal.title}
            {proposal.workflowId && (
              <span className="text-ink-muted"> — saved, not started</span>
            )}
          </Link>
        ) : (
          <div className="truncate text-xs text-ink-muted" title={proposal.title}>
            {proposal.title}
          </div>
        )}
        {proposal.error && <Hint tone="danger">{proposal.error}</Hint>}
      </div>
    </div>
  );
}

/**
 * One row of the thread list.
 *
 * Two lines, because one truncated line in a 360px column was all title: an
 * 80-character first message clipped away both the time and the waiting count,
 * which are the only two things telling these rows apart. Only the title
 * truncates, and it carries the full string for hover and assistive tech — the
 * pairing the runs list already uses.
 */
function ChatRow({
  entry,
  current,
  onOpen,
}: {
  entry: ChatListEntryDTO;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current ? "true" : undefined}
      title={entry.title ?? "Untitled"}
      className={`ui-transition cursor-pointer rounded-sm border-l-2 px-2 py-1.5 text-left font-normal ${
        CHAT_ROW[current ? "current" : "other"]
      }`}
    >
      <span className="block truncate text-xs">{entry.title ?? "Untitled"}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
        <span className="tabular-nums">{fmtRelative(entry.updatedAt)}</span>
        {entry.status === "thinking" && <span className="text-accent">thinking</span>}
        {/* A word in the row's own voice rather than a second accent chip
            beside the proposals one. Both are things waiting for the operator
            and the DTO keeps the counts apart on purpose — one is approving
            work and the other is answering a sentence — so a badge that looked
            identical to `N waiting` would send the reader to the wrong half of
            the page, which is the confusion not summing them exists to avoid.
            `thinking` is already drawn this way one span over, and the two can
            legitimately be true at once: `ask_operator` records its rows while
            the turn that called it is still running. */}
        {entry.pendingQuestionCount > 0 && (
          <span className="text-accent">
            {entry.pendingQuestionCount === 1
              ? "asked you"
              : `asked you ${entry.pendingQuestionCount}`}
          </span>
        )}
        {entry.pendingCount > 0 && (
          <Badge tone="accent">{entry.pendingCount} waiting</Badge>
        )}
      </span>
    </button>
  );
}

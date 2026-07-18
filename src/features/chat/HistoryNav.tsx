"use client";

/**
 * [TEAM: chat] The History sidebar section (§22.2) — recent chats moved out of
 * the ChatPanel's header drawer into a first-class SectionFlyout section, so
 * past conversations are reachable from the rail without crowding the top bar.
 *
 * PROP-LESS by contract: the SectionFlyout mounts registered components with
 * no props (src/shell/SectionFlyout.tsx), so everything here reads the chat
 * store directly and owns its own local state (search, rename, delete
 * confirm, the All-chats toggle). What moved verbatim from the drawer: the
 * opt-in "Save chats on this device" switch, New chat, search, and the row
 * affordances (rename pencil, inline confirm delete). What's new here:
 *
 *  - ChatGPT-style DATE GROUPING (Today / Yesterday / This week / Earlier)
 *    via the pure, clock-injectable groupByRecency (src/lib/historyGrouping);
 *  - context scoping: the CURRENT investigation's chats list first, with an
 *    "All chats" toggle that widens to every context (own chats still lead —
 *    conversationsAllContexts) — shown only when another context has chats;
 *  - opening a conversation closes the flyout (useSidebarFlyout.close), so
 *    the transcript you asked for is immediately in view.
 *
 * New chat rides the EXISTING `lighthouse:new-chat` window event (the
 * settings-menu / Mod+N seam) instead of calling the store directly, so the
 * ChatPanel's own cleanup (draft, attachments, the Undo strip) stays in one
 * place. Beam treatment: Fluent tokens only, the SectionRail/flyout palette.
 */

import { useMemo, useState } from "react";
import {
  Button,
  Input,
  SearchBox,
  Switch,
  Text,
  ToggleButton,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  CheckmarkRegular,
  DeleteRegular,
  DismissRegular,
  EditRegular,
} from "@fluentui/react-icons";
import {
  conversationsAllContexts,
  conversationsForContext,
  useChatStore,
} from "@/stores/useChatStore";
import { useSidebarFlyout } from "@/stores/useSidebarFlyout";
import { groupByRecency, relativeTimeLabel } from "@/lib/historyGrouping";

const useStyles = makeStyles({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
  },
  // Opt-in persistence control at the top of the section: a switch plus a hint
  // line that spells out where chats live and when they expire.
  persist: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    marginBottom: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  persistHint: { color: tokens.colorNeutralForeground3 },
  newChat: { width: "100%" },
  search: { width: "100%" },
  // The scoped/all view toggle sits under the search, quiet until engaged.
  scopeRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  scopeCaption: { color: tokens.colorNeutralForeground3 },
  list: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS },
  // Date-group headers, the SectionRail groupLabel treatment.
  groupLabel: {
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS, "2px"),
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
    ...shorthands.padding(tokens.spacingVerticalXXL, tokens.spacingHorizontalL),
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
    ":hover .hist-actions": { opacity: 1 },
    ":focus-within .hist-actions": { opacity: 1 },
  },
  rowActive: { backgroundColor: tokens.colorBrandBackground2 },
  rowMain: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    ...shorthands.padding("2px", "0"),
    cursor: "pointer",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    textAlign: "left",
    color: "inherit",
  },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowTime: { color: tokens.colorNeutralForeground3 },
  rowActions: { display: "flex", gap: "0", opacity: 0, transition: "opacity 120ms ease" },
  editRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, flex: 1 },
  confirm: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flex: 1,
    flexWrap: "wrap",
  },
  confirmText: { color: tokens.colorStatusDangerForeground1, flex: 1, minWidth: "100px" },
});

export function HistoryNav() {
  const styles = useStyles();
  const conversations = useChatStore((s) => s.conversations);
  const currentId = useChatStore((s) => s.currentId);
  const currentInvestigationId = useChatStore((s) => s.currentInvestigationId);
  const messages = useChatStore((s) => s.messages);
  const openConversation = useChatStore((s) => s.openConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const persistEnabled = useChatStore((s) => s.persistEnabled);
  const setPersistEnabled = useChatStore((s) => s.setPersistEnabled);
  const close = useSidebarFlyout((s) => s.close);

  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Whether another context even has chats — below, the All-chats toggle only
  // renders when flipping it would actually change the list.
  const hasOtherContexts = useMemo(
    () =>
      conversations.some(
        (c) => c.messages.length > 0 && (c.investigationId ?? null) !== currentInvestigationId,
      ),
    [conversations, currentInvestigationId],
  );

  // The listing: the current context first (§22.2) — scoped by default, every
  // context via the toggle (own chats still lead) — real (non-empty) chats
  // only, filtered by search, then bucketed Today/Yesterday/This week/Earlier.
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = showAll
      ? conversationsAllContexts(conversations, currentInvestigationId)
      : conversationsForContext(conversations, currentInvestigationId).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
    const listed = pool
      .filter((c) => c.messages.length > 0)
      .filter((c) => !q || c.title.toLowerCase().includes(q));
    return groupByRecency(listed);
  }, [conversations, currentInvestigationId, showAll, search]);
  const empty = groups.length === 0;

  /** Open a past conversation and close the flyout so the transcript shows. */
  function openChat(id: string) {
    if (id !== currentId) openConversation(id);
    close();
  }

  /** Commit an inline rename. */
  function commitRename(id: string) {
    const t = renameText.trim();
    if (t) renameConversation(id, t);
    setRenamingId(null);
    setRenameText("");
  }

  return (
    <nav aria-label="History" className={styles.section}>
      {/* Saving is opt-in: off by default, kept on this device when on, and
          auto-cleared after two weeks. */}
      <div className={styles.persist}>
        <Switch
          checked={persistEnabled}
          onChange={(_, d) => setPersistEnabled(Boolean(d.checked))}
          label="Save chats on this device"
        />
        <Text size={200} className={styles.persistHint}>
          {persistEnabled
            ? "Kept on this device and cleared automatically after two weeks. Delete any chat with its trash icon."
            : "Chats aren't being saved — they clear when you close the app. Turn this on to keep them here."}
        </Text>
      </div>
      <Button
        appearance="secondary"
        icon={<AddRegular />}
        className={styles.newChat}
        disabled={messages.length === 0}
        onClick={() => {
          // The existing cross-feature seam (settings menu / Mod+N): the
          // ChatPanel owns the draft/attachment cleanup and the Undo strip.
          window.dispatchEvent(new CustomEvent("lighthouse:new-chat"));
          close();
        }}
      >
        New chat
      </Button>
      <SearchBox
        className={styles.search}
        placeholder="Search chats…"
        value={search}
        onChange={(_, d) => setSearch(d.value)}
      />
      {hasOtherContexts && (
        <div className={styles.scopeRow}>
          <Text size={200} className={styles.scopeCaption}>
            {showAll ? "Every context, this one first" : "This context only"}
          </Text>
          <ToggleButton
            size="small"
            appearance="subtle"
            checked={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            All chats
          </ToggleButton>
        </div>
      )}
      {empty ? (
        <Text className={styles.empty}>
          {search
            ? "No chats match your search."
            : persistEnabled
              ? "Your saved chats will appear here."
              : "Chats from this session will appear here."}
        </Text>
      ) : (
        <div className={styles.list}>
          {groups.map((g) => (
            <div key={g.label} className={styles.list}>
              <Text size={200} weight="semibold" className={styles.groupLabel}>
                {g.label}
              </Text>
              {g.items.map((c) => {
                const active = c.id === currentId;
                if (renamingId === c.id) {
                  return (
                    <div key={c.id} className={styles.row}>
                      <div className={styles.editRow}>
                        <Input
                          value={renameText}
                          onChange={(_, d) => setRenameText(d.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(c.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          autoFocus
                          style={{ flex: 1 }}
                        />
                        <Button
                          size="small"
                          appearance="primary"
                          icon={<CheckmarkRegular />}
                          aria-label="Save name"
                          onClick={() => commitRename(c.id)}
                        />
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<DismissRegular />}
                          aria-label="Cancel rename"
                          onClick={() => setRenamingId(null)}
                        />
                      </div>
                    </div>
                  );
                }
                if (confirmDeleteId === c.id) {
                  return (
                    <div key={c.id} className={styles.row}>
                      <div className={styles.confirm}>
                        <Text size={200} className={styles.confirmText}>
                          Delete this chat?
                        </Text>
                        <Button
                          size="small"
                          appearance="primary"
                          onClick={() => {
                            deleteConversation(c.id);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Delete
                        </Button>
                        <Button
                          size="small"
                          appearance="subtle"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div
                    key={c.id}
                    className={mergeClasses(styles.row, active && styles.rowActive)}
                  >
                    <button
                      type="button"
                      className={styles.rowMain}
                      onClick={() => openChat(c.id)}
                    >
                      <Text
                        size={300}
                        weight={active ? "semibold" : "regular"}
                        className={styles.rowTitle}
                      >
                        {c.title}
                      </Text>
                      <Text size={200} className={styles.rowTime}>
                        {relativeTimeLabel(c.updatedAt)}
                      </Text>
                    </button>
                    <div className={mergeClasses(styles.rowActions, "hist-actions")}>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<EditRegular />}
                        aria-label="Rename chat"
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameText(c.title);
                          setConfirmDeleteId(null);
                        }}
                      />
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<DeleteRegular />}
                        aria-label="Delete chat"
                        onClick={() => setConfirmDeleteId(c.id)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

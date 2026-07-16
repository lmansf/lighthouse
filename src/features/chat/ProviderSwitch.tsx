"use client";

/**
 * Quick provider switch (time-savers TS-8): a compact menu in the chat header
 * for hopping between the CONFIGURED model providers — the private on-device
 * model (listed only once its weights are actually ready) and every cloud
 * vendor with a stored key — plus "Manage…" into the full AI-models dialog.
 *
 * Switching reuses the selectModel seam WITHOUT a key (the engine keeps the
 * provider's stored one) and applies from the NEXT ask: the pipeline reads the
 * profile's model config per ask, and the provenance stamp + local-only
 * enforcement key off the active provider, so both follow the switch with no
 * extra wiring (test/providerSwitch.test.mjs proves it engine-level). Managed
 * policy mirrors the AI-models dialog: disallowed providers render disabled
 * with the same "managed by your organization" note (the engine additionally
 * rejects server-side).
 */
import { useCallback, useState } from "react";
import {
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { BrainCircuitRegular, SettingsRegular } from "@fluentui/react-icons";
import { useAuthStore } from "@/stores/useAuthStore";
import { useRagStore } from "@/stores/useRagStore";
import { shortProviderLabel, switchArgs, switchChoices } from "@/lib/providerSwitch";

const useStyles = makeStyles({
  // Compact header trigger, sized like the EgressShield's (subtle, no bulk).
  trigger: { minWidth: "auto", ...shorthands.padding(0, tokens.spacingHorizontalXS) },
  // Quiet in-menu notes (empty state / managed policy) — informational rows,
  // not items, so keyboard navigation skips them.
  menuNote: {
    display: "block",
    maxWidth: "240px",
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalM),
  },
});

/** The confirmation wording for a completed switch. */
function switchedNote(providerId: string, label: string): string {
  const to = providerId === "local" ? "the private on-device model" : label;
  return `Now answering with ${to} — applies from your next ask.`;
}

export function ProviderSwitch({
  onSwitched,
}: {
  /** House-style transient strip host (ChatPanel renders it by the composer). */
  onSwitched: (note: { ok: boolean; text: string }) => void;
}) {
  const styles = useStyles();
  const onboarding = useAuthStore((s) => s.onboarding);
  const switchModel = useAuthStore((s) => s.switchModel);
  // Managed policy (add-managed-policy): null = unrestricted; a list means only
  // those providers may be selected — same gating as the AI-models dialog.
  const allowedProviders = useRagStore((s) => s.policy?.locks.allowedProviders ?? null);

  // Private-model readiness, read ONCE per menu open (the useLocalModel hook
  // polls for the install panel — far heavier than this menu needs). The last
  // known verdict is kept between opens so the list doesn't flicker.
  const [localReady, setLocalReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const probeLocal = useCallback(async () => {
    try {
      const r = await fetch("/api/model");
      if (r.ok) setLocalReady(((await r.json()) as { status?: string }).status === "ready");
    } catch {
      /* transient — keep the last known readiness */
    }
  }, []);

  const choices = switchChoices(onboarding.keyedProviders, localReady);
  const isAllowed = (id: string) => (allowedProviders ? allowedProviders.includes(id) : true);
  const label = shortProviderLabel(onboarding.providerId);

  const choose = useCallback(
    async (pid: string) => {
      const current = useAuthStore.getState().onboarding;
      if (pid === current.providerId) return; // re-picking the active provider is a no-op
      const args = switchArgs(pid, current);
      setBusy(true);
      try {
        // No key ever rides a switch — the engine keeps the stored one.
        await switchModel(args.providerId, args.modelId);
        onSwitched({ ok: true, text: switchedNote(pid, shortProviderLabel(pid)) });
      } catch {
        onSwitched({
          ok: false,
          text: "Couldn't switch the AI model — try again, or open Manage… to check its setup.",
        });
      } finally {
        setBusy(false);
      }
    },
    [switchModel, onSwitched],
  );

  return (
    <Menu
      hasCheckmarks
      checkedValues={{ provider: [onboarding.providerId ?? "local"] }}
      onCheckedValueChange={(_, d) => {
        if (d.name === "provider" && d.checkedItems[0]) void choose(d.checkedItems[0]);
      }}
      onOpenChange={(_, d) => {
        if (d.open) void probeLocal();
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <Tooltip
          content={`Answering with ${label}. Switch the AI model — applies from your next ask.`}
          relationship="description"
        >
          <MenuButton
            appearance="subtle"
            size="small"
            className={styles.trigger}
            icon={<BrainCircuitRegular />}
            disabled={busy}
            aria-label={`AI model: ${label} — switch`}
          >
            {label}
          </MenuButton>
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {choices.map((c) => (
            <MenuItemRadio
              key={c.id}
              name="provider"
              value={c.id}
              disabled={!isAllowed(c.id)}
              secondaryContent={c.hint}
            >
              {c.label}
            </MenuItemRadio>
          ))}
          {choices.length === 0 && (
            <Text size={200} className={styles.menuNote}>
              No other AI models are set up yet — add one under Manage….
            </Text>
          )}
          {allowedProviders && (
            <Text size={200} className={styles.menuNote}>
              Provider choice is managed by your organization.
            </Text>
          )}
          <MenuDivider />
          <MenuItem
            icon={<SettingsRegular />}
            onClick={() => window.dispatchEvent(new CustomEvent("lighthouse:open-ai-models"))}
          >
            Manage…
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

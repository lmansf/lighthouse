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
  MenuTrigger,
  Text,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconAI, IconSettings } from "@/shell/icons";
import { useAuthStore } from "@/stores/useAuthStore";
import { useRagStore } from "@/stores/useRagStore";
import { useOnDeviceModel } from "@/stores/useOnDeviceModel";
import { shortProviderLabel, switchArgs, switchChoices } from "@/lib/providerSwitch";
import { apiKeyBillingNote } from "@/lib/billingNotes";
import { MOBILE_NO_PROVIDER_TRUTHS } from "@/contracts";
import { LhMenuPopover } from "@/shell/controls";
import { platformKind } from "@/shell/desktopBridge";
import { usePaneLayout } from "@/shell/paneLayout";

const useStyles = makeStyles({
  // Compact header trigger, sized like the EgressShield's (subtle, no bulk).
  trigger: { minWidth: "auto", ...shorthands.padding(0, tokens.spacingHorizontalXS) },
  // §2 (iOS field patch 2): icon-only, thumb-sized trigger for the compact
  // arrangement — the full vendor label wrapped the 390pt header to two
  // lines (first-device report); it lives in the menu + aria-label instead.
  triggerCompact: { minWidth: "44px", minHeight: "44px" },
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
  disabledReason,
  submenu = false,
}: {
  /** House-style transient strip host (ChatPanel renders it by the composer). */
  onSwitched: (note: { ok: boolean; text: string }) => void;
  /**
   * Set = switching is unavailable and this is why (openspec:
   * add-investigations: a local-only investigation always answers on-device,
   * so the switch is moot there). The trigger stays focusable/hoverable
   * (disabledFocusable) so the reason is announced and shown as the tooltip;
   * the engine enforces the policy regardless — this is honesty, not the gate.
   */
  disabledReason?: string;
  /**
   * 0.14.2 compact header (field report IMG_1672): render as a nested
   * "AI model" submenu item for the header's More menu instead of a standalone
   * header button — same Menu state, roster, probe, and switching seam; only
   * the trigger changes.
   */
  submenu?: boolean;
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

  // add-mobile-local-inference: availability-filtered roster — on a mobile shell
  // the local entry appears only when the plugin reports a usable on-device
  // backend (else it stays gone). platformKind is primed from the first
  // capability payload well before the chat header renders; the store probes
  // once on a mobile shell (desktop keeps local via the desktop short-circuit).
  const platform = platformKind();
  const { available: onDeviceBackend } = useOnDeviceModel();
  // §2 (fp2): compact collapses the trigger to its icon — false at every
  // width on desktop (paneLayout's structural pin), so desktop is unchanged.
  const compact = usePaneLayout(false).compact;
  const choices = switchChoices(onboarding.keyedProviders, localReady, platform, onDeviceBackend);
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
        {submenu ? (
          <MenuItem
            icon={<IconAI />}
            disabled={busy}
            disabledFocusable={disabledReason !== undefined}
            secondaryContent={label}
            aria-label={disabledReason ?? `AI model: ${label} — switch`}
          >
            AI model
          </MenuItem>
        ) : (
          <Tooltip
            content={
              disabledReason ??
              `Answering with ${label}. Switch the AI model — applies from your next ask.`
            }
            relationship="description"
          >
            <MenuButton
              appearance="subtle"
              size={compact ? "medium" : "small"}
              className={compact ? styles.triggerCompact : styles.trigger}
              icon={<IconAI />}
              disabled={busy}
              disabledFocusable={disabledReason !== undefined}
              aria-label={disabledReason ?? `AI model: ${label} — switch`}
            >
              {/* §2: label only where it fits; the compact trigger is the brain
                  icon alone (the open menu names every choice). */}
              {compact ? null : label}
            </MenuButton>
          </Tooltip>
        )}
      </MenuTrigger>
      <LhMenuPopover>
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
              {/* §3 mobile empty state: exactly the two truths (narration
                  needs a cloud key; the private model is a desktop thing) —
                  the Manage… item below is the way in. */}
              {platform === "desktop"
                ? "No other AI models are set up yet — add one under Manage…."
                : MOBILE_NO_PROVIDER_TRUTHS}
            </Text>
          )}
          {allowedProviders && (
            <Text size={200} className={styles.menuNote}>
              Provider choice is managed by your organization.
            </Text>
          )}
          {/* Billing clarity (0.12.1 §4): the cost basis of the ACTIVE cloud
              model, always visible when the picker is open. Local = nothing to
              bill, so no note. */}
          {apiKeyBillingNote(onboarding.providerId) && (
            <Text size={200} className={styles.menuNote}>
              {apiKeyBillingNote(onboarding.providerId)}
            </Text>
          )}
          <MenuDivider />
          <MenuItem
            icon={<IconSettings />}
            onClick={() => window.dispatchEvent(new CustomEvent("lighthouse:open-ai-models"))}
          >
            Manage…
          </MenuItem>
        </MenuList>
      </LhMenuPopover>
    </Menu>
  );
}

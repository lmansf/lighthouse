"use client";

/**
 * Placeholder entry point for the future conversational mode (talk to Lighthouse
 * like Gemini in-browser - see GitHub issue #66). It does nothing yet except open
 * a friendly "coming soon" dialog; its purpose is to gauge demand.
 *
 * The button carries `data-log` / `data-log-type`, so the global click-capture
 * (src/features/usage/useUsageCapture) records every press as a `click_events`
 * row (label "converse-coming-soon") - subject to the user's usage-logging
 * consent. That gives us a demand signal for prioritizing the real build.
 */
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ChatSparkleRegular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  body: { color: tokens.colorNeutralForeground2 },
});

export function ConversePlaceholder() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        appearance="subtle"
        icon={<ChatSparkleRegular />}
        data-log="converse-coming-soon"
        data-log-type="nav"
        title="Conversational mode (coming soon)"
        onClick={() => setOpen(true)}
      >
        Converse
      </Button>

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Conversational mode - coming soon</DialogTitle>
            <DialogContent>
              <Text className={styles.body}>
                Soon you&apos;ll be able to have a free-flowing conversation with Lighthouse - ask
                anything and chat back and forth, like an assistant in your browser. It&apos;s on the
                way. Thanks for your interest - that&apos;s exactly what tells us to build it next.
              </Text>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary">Got it</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

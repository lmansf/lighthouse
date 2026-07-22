/**
 * §31 §3: the five replaced controls, one import surface. Everything NOT
 * exported here stays Fluent under the §1 token skin (Button, Field, Input,
 * Textarea, Badge, Spinner, desktop Tooltip, …) — the type/radius/shadow
 * tokens already re-dress those; only geometry that still read Windows was
 * replaced. See docs/design-language.md for the control inventory.
 */
export { LhSwitch, type LhSwitchProps } from "./LhSwitch";
export { LhSegmented, type LhSegmentedProps, type LhSegmentedOption } from "./LhSegmented";
export { LhDialogSurface, type LhDialogSurfaceProps } from "./LhDialog";
export { LhMenu, LhMenuPopover, type LhMenuProps, type LhMenuItem } from "./LhMenu";
export { LhSelect, type LhSelectProps, type LhSelectOption } from "./LhSelect";

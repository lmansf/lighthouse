# explorer-resize — delta

## ADDED Requirements

### Requirement: The explorer/chat divider is resizable

The main window SHALL render a draggable divider between the explorer sidebar and
the chat panel. The user SHALL be able to resize the sidebar by pointer drag and,
when the handle is focused, by arrow keys; the width SHALL be clamped to a
sensible minimum and maximum. The existing collapse-to-rail behavior SHALL be
preserved alongside the resize handle, and the 0.8.1 virtualized tree SHALL keep
its windowed rendering (no per-row mount regression).

#### Scenario: Pointer drag resizes the sidebar

- **WHEN** the user drags the divider handle left or right
- **THEN** the sidebar width follows the pointer within the min/max bounds, the
  width-collapse transition is suppressed during the drag so the handle tracks
  the cursor, and the chat panel reflows to fill the remaining space

#### Scenario: Keyboard resizes the focused handle

- **WHEN** the divider handle has keyboard focus and the user presses the left or
  right arrow key
- **THEN** the sidebar width decreases or increases by a fixed step within the
  min/max bounds, so the layout is adjustable without a pointer

#### Scenario: The collapse-to-rail affordance still works

- **WHEN** the user collapses the sidebar (the existing toggle / shortcut)
- **THEN** the sidebar collapses to the rail as before, independent of the stored
  resize width, and restoring it returns to the stored width

### Requirement: The explorer width persists per window mode

The sidebar width SHALL be persisted per window mode (`window` vs `widget`) in the
app-state settings, engine-validated (clamped to the same bounds), so a width set
in one mode is restored on the next launch of that mode and does not leak into the
other mode.

#### Scenario: A resized width is restored on relaunch

- **WHEN** the user resizes the sidebar in a given window mode and later relaunches
  the app in that mode
- **THEN** the sidebar opens at the stored width for that mode (clamped to the
  valid range), not the default width

#### Scenario: The engine clamps an out-of-range stored width

- **WHEN** a persisted width outside the valid min/max is read (a hand-edited or
  stale value)
- **THEN** the engine clamps it into the valid range rather than rendering a
  broken layout, and the settings round-trip preserves the clamped value

### Requirement: Double-click auto-fits the sidebar to the widest visible name

Double-clicking the divider handle SHALL widen (or narrow) the sidebar to fit the
widest currently-visible file name, within the max bound, so a truncated name can
be made fully visible in one gesture.

#### Scenario: Auto-fit reveals a long name

- **WHEN** the user double-clicks the divider handle while a long file name is
  truncated in the visible rows
- **THEN** the sidebar resizes to make that name fully visible (bounded by the
  max), and the new width persists like any other resize

### Requirement: Truncated rows disclose the full name and path

A file/folder row whose name is truncated SHALL expose the full name AND its
reconstructed vault path via the row's existing native `title` tooltip, without
adding a per-row portal-mounted tooltip component (which would regress the
virtualized tree's windowing performance).

#### Scenario: Hovering a truncated row shows name + path

- **WHEN** the user hovers a row whose name is ellipsized
- **THEN** a tooltip shows the full file name and its path (reconstructed by
  walking the parent chain), and this adds no per-row component mount — the row
  height and the windowing are unchanged

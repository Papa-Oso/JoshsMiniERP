# UI Style Guide

This app is a workbench for inventory, marketplace reviews, printing, and packaging. The UI should feel steady, compact, and operational: fast to scan, hard to misread, and consistent across pages.

## Core Principles

- Put the working tool on screen first. Avoid landing-page or marketing-style layouts.
- Keep repeated actions visually predictable. Similar commands should use the same button shape, icon style, and placement.
- Keep optional configuration hidden behind a settings control. The main workflow should not be crowded by setup fields.
- Every async action should give feedback in the pane where the action happened.
- Prevent invalid work early. If an action cannot produce a useful result, show the issue before creating files, printing, or mutating inventory.
- Use concise labels. Do not add instructional copy inside the app unless it prevents a real mistake.

## Professional Redesign Direction

The next full UI pass should feel like a professional operations workbench designed by a product designer, not a themed dashboard.

Target qualities:

- Calm: quiet surfaces, low visual noise, no glow-heavy hero treatment.
- Dense: useful information visible without feeling cramped.
- Durable: readable during repeated daily work, not just impressive in a screenshot.
- Trustworthy: destructive, disabled, warning, and success states must be unmistakable.
- Consistent: the same action should look and behave the same across Inventory, Item Management, Printing, and eBay Reviews.

Visual direction:

- Use a neutral dark or light-neutral base with restrained accent colors. Avoid the current neon/cyberpunk feel as the default product language.
- Remove decorative perspective grids, glow shadows, and ornamental gradients from the operational UI.
- Reserve color for meaning: primary action, success, warning, danger, selected, focus, and unread.
- Current local ERP palette: graphite base surfaces, teal for primary UI/action accents, green only for healthy/success states, amber for warnings, and red for danger/error states.
- Use typography scale conservatively. Page titles should identify the page, not dominate the work area.
- Prefer crisp separators, controlled spacing, and clear alignment over heavy card effects.
- Keep border radius at 8px or less.

Design tokens should be created before broad CSS changes:

- `--color-bg`
- `--color-surface`
- `--color-surface-raised`
- `--color-border`
- `--color-text`
- `--color-text-muted`
- `--color-primary`
- `--color-success`
- `--color-warning`
- `--color-danger`
- `--shadow-raised`
- `--space-*`
- `--radius-*`
- `--font-size-*`

Do not begin a page-by-page redesign until the token layer exists. Without tokens, consistency will drift again.

## Shared Components

Before or during the redesign, extract shared UI patterns instead of restyling each page independently.

Target shared pieces:

- `Panel`
- `PanelHeader`
- `Metric`
- `MiniStat`
- `StockMeter`
- `Notice`
- `Modal`
- `EmptyState`
- `ToolbarButton`
- `IconButton`
- `DataTable`
- `StatusBadge`
- `FileAssetRow`

Shared pieces should support the states the app already needs: loading, disabled, selected, empty, warning, danger, success, and read-only.

## Redesign Work Order

1. Create design tokens and replace hard-coded theme colors where practical.
2. Rework the app shell, topbar, tool drawer, settings button, and notification button.
3. Rework panels, buttons, form fields, tables, metrics, and notices globally.
4. Rework Inventory.
5. Rework Printing.
6. Rework Item Management.
7. Rework eBay Reviews.
8. Add accessibility and responsive verification.
9. Add Playwright visual smoke checks for the main pages.

Do not change inventory, printing, sync, or review business behavior as part of a pure visual redesign unless a UI bug requires it.

## Page Identity

Each main page should have a distinct lucide icon or small visual mark that matches the page purpose.

- Inventory: stock, shelves, or package-style icon.
- Item Management: tag, barcode, or item-library icon.
- Printing: printer, file, or document icon.
- eBay Reviews: review, star, or marketplace scan icon.

The icon should sit near the page title or primary page header. Do not rely on nav text alone for page identity.

## Layout

- Use full-width page sections and compact grids for work areas.
- Use panels for major tools and repeated records. Do not nest cards inside cards.
- Keep panel headers consistent: icon on the left, short title beside it, actions aligned to the right when needed.
- Use stable grid widths with `minmax`, fixed button heights, and predictable gaps so controls do not jump around.
- On mobile, controls should stack cleanly and keep all text inside the control.

## Buttons

- Use `icon-button` for commands.
- Use lucide icons when an icon exists for the action.
- Use `primary` only for the recommended or most common action in that group.
- Keep less-preferred actions secondary.
- Use danger styling only for destructive or risky actions.
- Do not use separate scrape buttons when the CSV buttons are the scrape actions.
- If there are full and incremental CSV actions, incremental should be visually preferred and full should be secondary.

## Settings

- Page-level settings should be opened from a gear/settings button.
- Settings should be hideable, similar to the Inventory stores control.
- Avoid permanent settings panels in the main workflow unless the setting is used constantly.
- Save buttons inside settings should clearly name what is saved, such as `Save Printers`.
- A settings error or success notice should stay inside the settings area.

## Notifications

- Use the topbar bell for cross-page alerts instead of adding alert panels to individual workflows.
- The bell should show an unread count for active alerts that have not been opened.
- Notifications should open in the same centered modal/backdrop pattern as settings.
- Current alert sources are low item inventory, low instruction inventory, sync issues, and printer status problems when Windows exposes them.
- Low and over-max inventory alerts are not dismissible; they clear only when the inventory state or threshold is fixed.
- Operational alerts, such as printer and sync problems, may be dismissible locally until the alert changes.
- Printer notifications should warn when a saved printer is missing, offline, stopped, or cannot be checked.

## Forms

- Remove fields that do not have a clear business use.
- Keep labels short and concrete.
- Prefer selects for known choices, toggles for boolean choices, and number inputs for quantities.
- For print quantities, ask for the business input the user thinks in. Example: instruction pages printed, then convert to instruction count using per-page quantity.

## Feedback

- Success messages should appear in the relevant pane.
- Errors should be specific and early.
- Print feedback belongs in printing or instruction documents, not product labels unless the action printed labels.
- File generation feedback belongs with the CSV or document action that generated the file.

## Inventory Rules

- Inventory charts should use the configured max inventory value, not a hard-coded 100.
- Inventory can exceed max. Over-max values should be visibly warned, such as red chart bars or red count text.
- Max inventory should be editable from Item Management.
- Instruction inventory should use the same max-based visualization pattern: current count, status, progress bar, max label, and over-max warning.
- Instruction max inventory should be editable from the Instruction Inventory pane.
- Instruction inventory is driven by item sales and item-to-instruction mappings, not manual use recording.

## Printing Rules

- Keep product labels and instruction documents as separate workflows.
- Product Labels and Instruction Documents should use matching panel structure: marked header icon, selector/quantity/primary print/upload controls in the same top-row positions, document asset card, and print action feedback inside the same pane.
- Printing page layout should group Product Labels directly above Instruction Documents, with Instruction Inventory on the right and Print Activity under it.
- Printing product labels means the products have been made, finished, and are entering sellable inventory. It adds item inventory based on the number of labels printed and records the activity note `Manufactured and ready for sale`.
- Product label print actions should stay visible but disabled when the selected SKU has no matching label file.
- Uploaded instruction documents should be printable from the instruction documents pane.
- Printing instruction pages adds instruction inventory based on pages times instructions per page.
- Printer selection belongs in hidden Print Settings.
- Support separate saved printers for labels and instruction documents.

## CSS Conventions

- Prefer existing classes before adding new ones: `icon-button`, `primary`, `settings-button`, `panel-header`, `notice`, `empty`.
- After the professional redesign starts, prefer shared tokens and shared components over page-specific one-off classes.
- Keep border radius at 8px or less unless an existing component already uses a different radius.
- Avoid one-note color themes. Accent color is useful, but the page should not become only one hue.
- Do not use decorative gradient blobs or ornamental backgrounds.
- Do not use glow, neon, or heavy gradient styling as the default UI language.
- Disabled primary buttons must look disabled, not merely muted active buttons.
- Tables and repeated rows should have visible column meaning. If a row has six columns, the user should not have to infer what each column is.
- Check desktop and mobile after layout changes.

## Verification Checklist

Before considering UI work done:

- Run `npm run build`.
- Run relevant tests when behavior changes.
- Open the affected page in the browser.
- Check desktop and mobile widths.
- Confirm buttons align, text fits, empty states are sane, and async actions show feedback in the right place.
- Confirm keyboard focus is visible and dialogs can be closed without a mouse.
- Confirm color alone is not the only signal for dangerous, warning, selected, or disabled states.
- Capture screenshots for Inventory, Item Management, Printing, and eBay Reviews after broad visual changes.

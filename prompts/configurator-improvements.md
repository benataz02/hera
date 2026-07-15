I want to improve configurator. Use UI5 mcp to see the available components and understand in detail how they work

# Runtime
- The wizard step should take full page height
- Merge configure/batches steps into one
- Merge candidates/outputs steps into one

## Header
- Top bar should be inside wizard steps bar, check available props.

## Configure step
- Remove layout?: "flow" | "page" prop. Remove objectpage, panel
- Use only Form, FormGroup, FormItem. Find a way to divide sections, groups from config engine using form subcomponents. If there isn't any, evaluate merging sections and groups and leaving only 1 level
- FloatingFooter content must go inside the step floating bar on the left (next: batches)

 # Builder
- Select using Queries must use Input + value help (SelectDialog with search + Table)
- Select using Table keep using Select component
- For both table/query the user might define key + n columns. These columns by default will appear in the valuehelp/select components (not only label column as currently does), unless users says not to. These columns will be saved as parameters and will be used in formullas or pricing definition fields, same as the rest of the params/formullas.
- Reorganize and improve parameter edit dialogs UI. Table/query definition will be done in Tables section only, not in parameter dialogs.
- Form structure bar defined inside Table. Check available props for that.
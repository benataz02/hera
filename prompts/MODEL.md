# Configurator model and model builder
I want the configurator to have a constraint propagation engine and a builder of those engine models.
The model builder will be a UI builder + business logic with CSP engine builder

Form and FormGroups will have visibility formullas to set visible or not, if a group is set unvisible, all subyacent items will be invisible too
The tabs with formullas, must use the dedicated UI5 components to define formullas

## Model builder
User will edit the elements by clicking. This will open a Dialog. The modal will have the tabs:

If Group
- Input: Description

If Item
- Input: Description
- Tab: Input
    - Toggle: Mandatory
    - Dropdown: Data source
    - Dropdown: Input Type
    - Value: you can asign a formulla or manually indicate a value
- Tab: Output, empty for now
- Tab: Price (formulla)

### Builder UI
Use  UI5 Table component with the features:
- Drag and drop (for FormGroups, FormItems (inputs), formullas)
- With Group rows
Use UI5 MCP (UI5 mcr) otherwise fetch docs: https://ui5.github.io/webcomponents-react/v2/?path=/docs/data-display-table--docs or/and API

### Dropdown: Data source
There can be 3 Data sources:
- Normal
- Table: User can define tables that are stored in the database.
- Query: User can select a datasource (SAP B1 ServiceLayer, Beas service layer, others) and write a REST query to do a GET fetch

### Dropdown: UI Element
User can select type of input
- Input: UI5 Input with SuggestionItem
- Radiobox: UI5 SegmentedButton
- Checkbox: UI5 Checkbox
- MultiComboBox: UI5 MultiComboBox

### Table
New table creation route under configure (like Models in sidenavigation)
UI5 Table component with drag and drop sorting
Columns: Sort (autodetermined, unvisible for user), value, name

# Simple model example
Company with discrete manufacturing. They produce panels, plaques or elevatator button boxes. They take aluminium sheets from 0.5mm to 10mm, they apply anodizing, matt or color treatment, print with serigraphy or digital printing depending quantities, and then machine it with punching, laser cut, or millig depending quality needed. Depending if they have to print with digital or serigraphy, the aluminium sheet format will be 1000x500mm for digital or 500x500 for seri. If pieces dont fit in the standard formats, the configurator must calculate the most optimum format for min material waste. Remember the framework must work for any kind of company, I just want to see an specific example

# Configuration process
There will be another page where the user will create the configurations during the quotation process.

Introduce parameters -> Define price batches (to compare for x quantity price or n quantity price) -> Apply contraint egine -> Visualize possible configurations (possible combinations) -> select 1 or n for the quote and create it in SAP

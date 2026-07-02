# Configurator model and model builder
How does product configurator from team center work? I want to create a web configurator based on the same concepts. I want a configurator based on parameters, domains that is able to output valid bom with calculated quantity and prices, and also output a routing with calculated setup + process times and cost, following teamcenter configurator concepts.

## Configurato UI
The user will define parameters and their groups/sections in the model builder using a UI5 table with drag and drop, so then they can be rendered on the configurator using UI5 components following this hierarchy:
- ObjectPage
- ObjectPageSection (sections)
- FormGroup (parameter group)
- FormItem (single parameter)

### Domain source
- Manual: Manually defined list
- Table: User can define tables that are stored in the database.
- Query: User can select a datasource (SAP B1 ServiceLayer, Beas service layer, others) and write a REST query to do a GET fetch

### Dropdown: UI Element
User can select type of input
- Input: UI5 Input with SuggestionItem + ValueHelp concept
- Radiobox: UI5 Radio
- Checkbox: UI5 Checkbox
- MultiComboBox: UI5 MultiComboBox

# Configuration process
There will be another page where the user will create the configurations during the quotation process.

- Introduce parameters
- Define batches (to compare prices for each possible batch)
- Apply config engine
- Visualize possible configurations
- select 1 or n configurations
- Validate/edit output bom/routing
- Create quote in SAP B1

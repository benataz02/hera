I want to replace and big bang refactor the current table/query functionality and unify/simplify it. There must be a single entity called Configuration Master data. Inside this new entity master data can be defined either manually or with queries. The first column/field in the table/query will be the key value.

SelectDialog will show all the columns defined in the master data element. SuggestionItem will show the first two (add a hint/tooltip for the user explaining this)

For API queries, user will be able to test it, retry, and see errors using valuestate, messages from UI5. Queries will also have a sync check, which if user selects it the data will be stored in postgresdb and fetched from there instead of querying everytime through API, by default activate this option.

Use an ObjectPage with sections for the UI. Use UI5 mcp to see which components to use ajd understand how they work. Delete old UI and functionality.
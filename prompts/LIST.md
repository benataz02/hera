When using SelectDialog + ListItemStandard + Input i have the following problems:
- When I select a value from dialog it doesnt pass to the input
- The input styling (width for example) is not the same as the free inputs. Must be same
- The dialog width is always 90%, even when there are only 2 columns. The dialog feels super stretched. Width should adapt to fit content properly.
- Dialog List has no column names.
- Eliminate coerce function, its transforming string itemcodes to numbers and losing data. And I dont believe its necessary.
- Is keyOf func necessary? I prefer to delete it
- Review overall implementation of UI5 and functionality in the file and improve - simplify - cleanup it based on docs and best practices

Use UI5 mcp to understand very well how these components work and find out the best and most standard possible solutions to these problems.
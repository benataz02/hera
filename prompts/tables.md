I want to introduce a feature to support merge production configurations. Which consists of n items that come out from a single configuration, which basically means 1 config, 1 bom, 1 routing, n items. T

he user should be able to define an item matrix, each one with its own configurations. For example, item 1, widh x, length y. Item 2, width z, length a, etc. The user will define the parameters per item, and will be able to link them to SAP B1 quotation fields, so when creating a quotation these will be included in the DocumentLines.

The parameters in the item matrix will be:
- ItemCode: there will be a user field in B1 document lines to display a custom code in the crystal layouts instead of the generic B1 item from the configurator, without having to create one.
- ItemName: Description
- N parameters defined by user.

None of the item matrix parameters will be considered in the configuration engine domains. But exprHelpers.ts will be able to consider them for building the formullas.

Apart from this, I want users to be able to create a table and define options for columns, or calculated cell formullas, so generate calculated sum values. For example:
a metal sheet can have n machined holes. User can define a table with a column, hole type (circular/rectangular), calculate perimeter based on item dimensions. Then with the machining speed parameter calculate the sum of time to machine the diferent holes defined in the user table.

Item table will be included by default in the configuratorform. Other tables can be added in the form from the paramdialog.

You can create a common table component which solves item matrix + user table use cases.

Lets do a q&a to define in detail these problems
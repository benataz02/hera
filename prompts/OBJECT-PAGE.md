# Entity object page
Replace the current list entity page with variant management, DynamicPage and FilterBar using SAP UI5 webcomponents.

## Components to use
- Variant management. Docs: https://ui5.github.io/webcomponents-react/v2/?path=/docs/inputs-variantmanagement--docs&args=;className:
- DynamicPage. Docs: https://ui5.github.io/webcomponents-react/v2/?path=/docs/layouts-floorplans-objectpage--docs
- FilterBar: https://ui5.github.io/webcomponents-react/v2/?path=/docs/layouts-floorplans-filterbar--docs

Fetch the links, and explore also the apis to fully understand how the components work and interact with each other before doing anything

## Requirements
This will be a single abstract component that will handle all entities visualization
When clicking a row in the list page, it will navigate to detail page
Use UI5 ObjectStatus badges or other elements to beautify the UI

# ERP/MES integration
The product will integrate with SAP B1 using Service Layer or other REST APIs to retrieve all the master data from the ERP or other MES system (Beas Manufacturing, etc.) so main integration point will be SAP and then open to integrate also with other system / datasources.
Deep integration with sap b1 service layer. Use metadata endpoint to autodiscover SAP entities and autodefine all the schemas (get/put/post). Tenant admins will decide which schemas to include in the app and if they will be read only or also edit/create.

## Service setup
The admins only will have a panel configure the entities. In case of SAP B1 SL and Beas SL the entities will be discovered by fetching metadata endpoint first (this will return an xml of the available endpoints), this will show available entities. Admin will select which entities to include in the app (quotations, sales orders, business partners, etc.)

## Entity visualization
The selected entities will be added to UI5 navigation menu, and will have a dedicated page to visualize them. For now do a basic list only to see results. The data will be pulled through the cloud to onprem agent.

# AppShell + Menu
The app will use SAP UI5 NavigationLayout component for the appshell and main layout
/**
 * B1 Entity Category Mappings
 * 
 * Maps SAP Business One Service Layer entities to business area categories.
 * Used for entity discovery and categorization in the B1 Tool Registry.
 * 
 * Note: Entities can belong to multiple categories. For example:
 * - "BusinessPartners" appears in business-partners and master-data categories.
 * - "SalesOpportunities" appears in sales and crm categories.
 * 
 * This mapping is based on the standard SAP Business One Service Layer entities as of B1 10.0 FP 2608.
 * It may need to be updated as new entities are added or categorized differently in future releases.
 */

/**
 * Category mappings for B1 entities
 * Maps category names to arrays of entity names
 */
const B1_CATEGORY_MAPPINGS: Record<string, string[]> = {
    // ====================================================================================
    // SALES & CUSTOMER RELATIONSHIPS
    // ====================================================================================
    'sales': [
        // Core sales documents
        'Quotations',
        'Orders',
        'DeliveryNotes',
        'Returns',
        'ReturnRequest',
        'Invoices',
        'CreditNotes',
        'DownPayments',
        'CorrectionInvoice',
        'CorrectionInvoiceReversal',
        'Drafts',

        // Sales opportunities and activities
        'SalesOpportunities',
        'SalesOpportunitySourcesSetup',
        'SalesOpportunityInterestsSetup',
        'Activities',
        'ActivityLocations',
        'ActivityStatuses',
        'ActivityRecipientLists',
        'BlanketAgreements',

        // Sales configuration
        'SalesPersons',
        'Territories',
        'SpecialPrices',
        'EnhancedDiscountGroups',
        'Campaigns',
        'SalesForecast',
        'CommissionGroups',
        'TargetGroups',
        'SalesStages',
    ],

    // ====================================================================================
    // PURCHASE & VENDOR MANAGEMENT
    // ====================================================================================
    'purchase': [
        // Core purchasing documents
        'PurchaseQuotations',
        'PurchaseOrders',
        'PurchaseDeliveryNotes',
        'PurchaseReturns',
        'PurchaseInvoices',
        'PurchaseCreditNotes',
        'GoodsReturnRequest',
        'PurchaseDownPayments',
        'PurchaseRequests',
        'CorrectionPurchaseInvoice',
        'CorrectionPurchaseInvoiceReversal',
        'Drafts',

        // Vendor management & pricing
        'BlanketAgreements',
        'CustomsGroups',
        'CustomsDeclaration',
        'LandedCosts',
        'LandedCostsCodes',
        'AdditionalExpenses',
    ],

    // ====================================================================================
    // BANKING & PAYMENTS
    // ====================================================================================
    'banking': [
        // Bank accounts & statements
        'BankStatements',
        'BankPages',
        'HouseBankAccounts',
        'ChecksforPayment',
        'BankChargesAllocationCodes',
        'PaymentBlocks',
        'CentralBankIndicator',

        // Payments
        'IncomingPayments',
        'VendorPayments',
        'PaymentDrafts',
        'PaymentRunExport',
        'BillOfExchangeTransactions',

        // Payment methods & configuration
        'Banks',
        'PaymentWizards',
        'CreditPaymentMethods',
        'CreditCardPayments',
        'CreditCards',
        'ChecksforPayment',
        'PaymentBlocks',
        'PaymentReasonCodes',
        'WizardPaymentMethods',
        'Deposits',

        // Cash flow
        'CashFlowLineItems',
    ],

    // ====================================================================================
    // FINANCE & ACCOUNTING
    // ====================================================================================
    'finance': [
        // Accounts Receivable (AR)
        'IncomingPayments',

        // Accounts Payable (AP)
        'VendorPayments',

        // General Ledger & Journals
        'JournalEntries',
        'ChartOfAccounts',
        'GLAccountAdvancedRules',
        'JournalEntryDocumentTypes',
        'InternalReconciliations',

        // Budgeting & Forecasting
        'Budgets',
        'BudgetScenarios',
        'DistributionRules',
        'ProfitCenters',
        'DistributionRules',
        'CostElements',

        // Projects
        'Projects',
        'ProjectManagements',
        'ProjectManagementTimeSheet',

        // Fixed Assets
        'AssetClasses',
        'DepreciationAreas',
        'DepreciationTypes',
        'DepreciationTypePools',
        'AssetDepreciationGroups',
        'AssetGroups',
        'AssetManualDepreciation',
        'AssetCapitalization',
        'AssetCapitalizationCreditMemo',
        'AssetTransfer',
        'AssetRetirement',
        'AssetRevaluations',
        'AttributeGroups',
        'FAAccountDeterminations',

        // Accounting Setup & Configuration
        'ClosingDateProcedure',
        'Currencies',
        'PaymentTermsTypes',
        'WithholdingTaxCodes',
        'WTaxTypeCodes',
        'VatGroups',
        'SalesTaxCodes',
        'SalesTaxAuthorities',
        'DunningTerms',
        'DunningLetters',
        'DeductibleTaxes',
        'CashDiscounts',
        'FinancialYears',
        'AccountSegmentations',
        'AccountSegmentationCategories',
        'FactoringIndicators',
        'AccrualTypes',
        'CostCenterTypes',
        'BudgetDistributions',
        'AccountCategory',
        'BOEDocumentTypes',
        'BOEInstructions',
        'BOEPortfolios',
        'OccurrenceCodes',
        'PostingTemplates',
        'RecurringTransactionTemplates',
        'RecurringPostings',
        'DeterminationCriterias',
        'ExpenseTypes',
        'TaxCodeDeterminations',
        'TransactionCodes',
    ],

    // ====================================================================================
    // INVENTORY & WAREHOUSE MANAGEMENT
    // ====================================================================================
    'inventory': [
        // Master data
        'Items',
        'ItemGroups',
        'ItemProperties',
        'Warehouses',
        'BinLocations',
        'BinLocationAttributes',
        'UnitOfMeasurements',
        'UnitOfMeasurementGroups',
        'BarCodes',
        'AlternateCatNum',
        'PackagesTypes',
        'SerialNumberDetails',
        'BatchNumberDetails',
        'MaterialGroups',
        'ItemImages',
        'InventoryCycles',
        'LengthMeasures',
        'WeightMeasures',

        // Inventory transactions
        'StockTransfers',
        'StockTransferDrafts',
        'StockTakings',
        'InventoryTransferRequests',
        'InventoryGenEntries',
        'InventoryGenExits',
        'InventoryPostings',
        'MaterialRevaluation',
        'InventoryCountings',
        'InventoryCountingDrafts',
        'CycleCountDeterminations',
        'PickLists',

        // Logistics & shipping
        'DeliveryNotes',
        'Returns',
        'ReturnRequest',
        'ShippingTypes',
        'TransportationDocument',
        'RouteStages',
        'EWBTransporters',

        // Warehouse management
        'WarehouseLocations',
        'TrackingNotes',

        // Details & dimensions
        'WarehouseSublevelCodes',
        'BinLocationFields',
        'InventoryOpeningBalances',
    ],

    // ====================================================================================
    // PRODUCTION & MANUFACTURING
    // ====================================================================================
    'production': [
        'Manufacturers',
        'ProductionOrders',
        'ProductTrees',
        'Resources',
        'ResourceGroups',
        'ResourceProperties',
        'MRPScenarios',
        'ResourceCapacities',
    ],

    // ====================================================================================
    // BUSINESS PARTNER & CUSTOMER MANAGEMENT
    // ====================================================================================
    'business-partner': [
        // Core business partner data
        'BusinessPartners',
        'BusinessPartnerGroups',
        'BPVatExemptions',

        // Contact & communication
        'Contacts',
        'Relationships',
        'ActivityRecipientLists',

        // Classification & segmentation
        'SalesPersons',
        'Territories',
        'Industries',
        'Countries',
        'States',
        'BPPriorities',
        'BusinessPartnerProperties',
        'PartnersSetups',
    ],

    // ====================================================================================
    // HUMAN RESOURCES & ORGANIZATION
    // ====================================================================================
    'hr': [
        // Employee & organization structure
        'EmployeesInfo',
        'EmployeeRolesSetup',
        'EmployeePosition',
        'EmployeeIDType',
        'Teams',
        'Departments',
        'Branches',
        'UserDefaultGroups',
        'ProfitCenters',
        'Genders',
        'Holidays',

        // Time management
        'ProjectManagementTimeSheet',

        // Expenses & benefits
        'EmploymentCategorys',
        'EmployeeStatus',
        'TerminationReason',
        'EmployeeTransfers',
        'EmployeeImages',
    ],

    // ====================================================================================
    // SERVICE & TECHNICAL SUPPORT
    // ====================================================================================
    'service': [
        // Service calls & tickets
        'ServiceCalls',
        'ServiceCallSolutionStatus',
        'ServiceCallProblemTypes',
        'ServiceCallProblemSubTypes',
        'ServiceCallStatus',
        'ServiceCallTypes',
        'ServiceCallOrigins',

        // Service contracts
        'ServiceContracts',
        'ContractTemplates',

        // Equipment tracking
        'CustomerEquipmentCards',
        'KnowledgeBaseSolutions',
        'ServiceGroups',
    ],

    // ====================================================================================
    // MASTER DATA & CORE REFERENCE
    // ====================================================================================
    'master-data': [
        // Items & products
        'Items',
        'ItemGroups',
        'ItemProperties',
        'BarCodes',
        'AlternateCatNum',
        'IdentificationCodes',

        // Business partners
        'BusinessPartners',
        'BusinessPartnerGroups',

        // Warehouses & locations
        'Warehouses',
        'BinLocations',
        'BusinessPlaces',
        'Counties',

        // Financials
        'ChartOfAccounts',
        'ProfitCenters',
        'Projects',
        'Currencies',
        'ExchangeRates',
        'Countries',
        'States',
        'UserLanguages',

        // Commercial
        'PaymentTermsTypes',
        'PriceLists',
        'SpecialPrices',

        // Shipping & packaging
        'ShippingTypes',
        'PackagesTypes',
        'CarrierTypes',
        'TransportationDocument',

        // Taxation
        'WithholdingTaxCodes',
        'SalesTaxCodes',
        'VatGroups',
        'SalesTaxAuthorities',
        'WTaxTypeCodes',
        'PaymentReasonCodes',

        // Reference values
        'Series',
        'NumberingSeries',
        'CertificateSeries',
        'Dimensions',
        'LocalEra',
        'IdentificationCodes',
        'Pictures',
    ],

    // ====================================================================================
    // CUSTOMIZATION & EXTENSIONS
    // ====================================================================================
    'customization': [
        // User-defined fields & tables
        'UserFieldsMD',
        'UserTablesMD',
        'UserObjectsMD',

        // Custom data structures
        'UserFields',
        'UserQueries',
        'QueryCategories',
        'QueryAuthGroups',
        'UserKeysMD',
        'FormattedSearches',

        // Access & permissions
        'UserGroups',

    ],

    // ====================================================================================
    // SYSTEM ADMINISTRATION & CONFIGURATION
    // ====================================================================================
    'system': [
        // User management
        'Users',
        'UserDefaultGroups',
        'UserLanguages',
        'UserPermissionTree',
        'UserGroups',

        // System settings
        'AlertManagements',
        'Holidays',
        'Messages',
        'PredefinedTexts',
        'EventNotifications',
        'SingleUserConnections',
        'DynamicSystemStrings',
        'EmailGroups',
        'ShortLinkMappings',
        'Attachments2',
        'DistributionLists',
        'B1Sessions',
        'ElectronicFileFormats',
        'MobileAddOnSetting',
        'TSRExceptionalEvents',

        // Approvals & workflows
        'ApprovalTemplates',
        'ApprovalRequests',
        'ApprovalStages',

        // Integration & automation
        'EventSubscriptions',
        'IntegrationPackagesConfigure',
        'SQLQueries',
        'ValueMapping',
        'ValueMappingCommunication',

        // Data ownership & security
        'DataPrivacyProtection',
        'DataSensitiveStatus',
    ],

    // ====================================================================================
    // CRM & MARKETING
    // ====================================================================================
    'crm': [
        // Blanket agreements
        'BlanketAgreements',

        // Opportunities & sales
        'SalesOpportunities',
        'SalesOpportunitySourcesSetup',
        'SalesOpportunityInterestsSetup',
        'SalesOpportunityReasonsSetup',
        'SalesOpportunityCompetitorsSetup',

        // Activities & engagement
        'Activities',
        'ActivityLocations',
        'ActivityStatuses',
        'ActivityRecipientLists',
        'ActivitySubjects',
        'ActivityTypes',

        // Campaigns & marketing
        'Campaigns',
        'CampaignResponseType',

        // Contacts & relationships
        'Contacts',
        'Relationships',

        // Knowledge & support
        'Queue',

        // Sales forecasting
        'SalesForecast',
        'SalesPersons',
        'Territories',
        'Industries',
        'TargetGroups',
    ],

    // ====================================================================================
    // LOCALIZATION & REGULATORY
    // ====================================================================================
    'localization': [
        // Tax reporting
        'TaxInvoiceReport',
        'SalesTaxInvoices',
        'PurchaseTaxInvoices',
        'Forms1099',
        'TaxExemptReasons',

        // Electronic documents (region-specific)
        'ElectronicDocuments',
        'EBooks',

        // Regional/country-specific documents
        'SelfInvoices',
        'SelfCreditMemos',
        'BEMReplicationPeriods',
        'IntrastatConfiguration',
        'LegalData',
        'FiscalPrinter',
        'TaxReplStateSubs',
        'ExceptionalEvents',

        // Indian specific (GST/TDS)
        'ISDDocuments',
        'ISDInvoices',
        'ISDCreditMemos',
        'ISDRecipientInvoices',
        'ISDRecipientCreditMemos',
        'TaxCodeDeterminationsTCD',
        'Sections',
        'IndiaHsn',
        'IndiaSacCode',
        'NatureOfAssessees',
        // Withholding tax
        'WithholdingTaxCodes',
        'SpecificWTHAmountsService',
        'WTaxTypeCodes',
        'DeductionTaxGroups',
        'DeductionTaxSubGroups',
        'DeductionTaxHierarchies',
        'DeductibleTaxes',
        'NCMCodesSetup',
        'WitholdingTaxDefinition',

        // Brazil-specific
        'BPFiscalRegistryID',
        'BrazilBeverageIndexers',
        'BrazilFuelIndexers',
        'BrazilNumericIndexers',
        'BrazilStringIndexers',
        'BrazilMultiIndexers',
        'GovPayCodes',
        'POSDailySummary',
        'NotaFiscalCFOP',
        'NotaFiscalCST',
        'NotaFiscalUsage',
        'NFModels',
        'NFTaxCategories',

        // Data protection & sensitivity
        'RetornoCodes',
        'TaxWebSites',
        'SalesTaxAuthoritiesTypes',
        'ExportDeterminations',
        'DNFCodeSetup',
        'CIGCodes',
        'CESTCodes',
        'CUPCodes',
        'ImportDeterminations',
    ],

    // ====================================================================================
    // REPORTING & ANALYTICS
    // ====================================================================================
    'reporting': [
        // Reports & types
        'ReportTypes',
        'TaxInvoiceReport',

        // Formatting & layouts
        'DefaultElementsforCR',

        // DATEV or ELSTER export (German accounting)
        'DatevRuns',
        'ElsterRun',

        // User queries
        'UserQueries',
        'QueryCategories',
        'QueryAuthGroups',

        // Preferences
        'KPIs',
        'SQLQueries',
        'SQLViews',
        'ReportFilter',
    ],

    // ====================================================================================
    // WEB CLIENT & USER INTERFACE CONFIGURATION
    // ====================================================================================
    'ui': [
        'WebClientListviewFilters',
        'WebClientPreferences',
        'WebClientVariants',
        'WebClientVariantGroups',
        'WebClientFormSettings',
        'WebClientDashboards',
        'WebClientRecentActivities',
        'WebClientBookmarkTiles',
        'WebClientNotifications',
        'WebClientLaunchpads',
        'ColumnPreferences',
        'FormPreferences',
        'ExtendedTranslations',
        'PredefinedTexts',
        'MultiLanguageTranslations',
        'ChooseFromList',
        'Cockpits',
    ],

    'workflow': [
        // Workflow tools (not actual entities, but categorized for discovery)
        'b1_copy_document',
        'b1_create_payment',
    ],

    'user-defined-table': [
        // Populated dynamically — any EntitySet starting with U_ and table identifier starting with @
    ],

    'user-defined-object': [
        // Populated dynamically — any EntitySet NOT starting with U_ and table identifier starting with @
    ],
};

/**
 * Get all valid category keys from B1_CATEGORY_MAPPINGS
 * @returns Array of category names (excluding 'all')
 */
export function getValidCategories(): string[] {
    return Object.keys(B1_CATEGORY_MAPPINGS);
}

/**
 * Get all valid category keys including 'all'
 * @returns Array of category names including 'all'
 */
export function getAllCategories(): string[] {
    return ['all', ...getValidCategories()];
}

/**
 * Build a reverse mapping: entity name (lowercase) -> categories
 * @returns Map of entity names to their categories
 */
export function buildEntityToCategoriesMap(): Map<string, string[]> {
    const entityToCategories = new Map<string, string[]>();

    for (const [category, entities] of Object.entries(B1_CATEGORY_MAPPINGS)) {
        for (const entity of entities) {
            const entityLower = entity.toLowerCase();
            const categories = entityToCategories.get(entityLower) || [];
            if (!categories.includes(category)) {
                categories.push(category);
            }
            entityToCategories.set(entityLower, categories);
        }
    }

    return entityToCategories;
}

/**
 * Get a formatted description of all available categories with examples
 * @returns Formatted string describing all categories
 */
export function getCategoryDescriptions(): string {
    const categories = getValidCategories();
    const examples: Record<string, string> = {
        'sales': 'Orders, Quotations, Invoices, DeliveryNotes',
        'purchase': 'PurchaseOrders, PurchaseInvoices, GoodsReceiptPO',
        'banking': 'BankStatements, IncomingPayments, VendorPayments',
        'finance': 'Payments, JournalEntries, ChartOfAccounts',
        'inventory': 'Items, Warehouses, StockTransfers, BatchNumbers',
        'production': 'ProductionOrders, ProductTrees, Resources',
        'business-partner': 'BusinessPartners, Contacts, SalesPersons',
        'hr': 'EmployeesInfo, Departments, Teams',
        'service': 'ServiceCalls, ServiceContracts, CustomerEquipmentCards',
        'master-data': 'Items, BusinessPartners, ChartOfAccounts, Currencies',
        'customization': 'UserFieldsMD, UserTablesMD, UserObjectsMD',
        'system': 'Users, ApprovalTemplates, AlertManagements',
        'crm': 'SalesOpportunities, Activities, Campaigns',
        'localization': 'TaxInvoiceReport, WithholdingTaxCodes, ElectronicDocuments',
        'reporting': 'ReportTypes, UserQueries, KPIs',
        'payment': 'IncomingPayments, VendorPayments, PaymentDrafts',
        'ui': 'WebClientPreferences, Cockpits, ColumnPreferences',
        'workflow': 'b1_copy_document, b1_create_payment',
        'user-defined-table': 'company-specific',
        'user-defined-object': 'company-specific',
    };

    return categories
        .map(cat => `'${cat}' (${examples[cat] || 'various entities'})`)
        .join(', ');
}

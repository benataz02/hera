# Configurator model and model builder
I want the configurator to have a constraint propagation engine and a builder of those engine models. The constraint engine must handle:
- Formullas
- Valid values definition (coming both harcoded into model or from a datasource SAP B1 Service Layer or others) such as possible parameters, bom materials selected from b1 item list, etc.

The engine will be able to output:
    - Configuration jsonb
    - Bom (in SAP, Beas or others using REST API service layer)
    - Routing (in SAP, Beas or others using REST API service layer)

It will have an admin/owner only panel to create the models, using SAP UI5 components, where the admins will setup n possible models each one with their business logic.

# Configuration process
There will be another page where the user will create the configurations during the quotation process.

Introduce parameters -> Define price batches (to compare for x quantity price or n quantity price) -> Apply contraint egine -> Visualize possible configurations (possible combinations) -> select 1 or n for the quote and create it in SAP

# Simple example
Company with discrete manufacturing. They produce panels, plaques or elevatator button boxes. They take aluminium sheets from 0.5mm to 10mm, they apply anodizing, matt or color treatment, print with serigraphy or digital printing depending quantities, and then machine it with punching, laser cut, or millig depending quality needed. Depending if they have to print with digital or serigraphy, the aluminium sheet format will be 1000x500mm for digital or 500x500 for seri. If pieces dont fit in the standard formats, the configurator must calculate the most optimum format for min material waste. Remember the framework must work for any kind of company, I just want to see an specific example

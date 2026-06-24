# Product Configurator Architecture: Executive Summary

This document summarizes the core architectural framework for building a high-performance product configurator with a constraint propagation engine and a dynamic UI builder using **Vite** and **TypeScript**.

## 1. The Data Model (Source of Truth)
The configuration model must be entirely **declarative and serializable** (JSON-compatible) to enable seamless persistence and API integrations.

* **Features (Variables):** The attributes of the product (e.g., Color, Material, Size). Each has a specific `uiType` to guide the UI builder.
* **Options (Domains):** The specific choices available for each feature (e.g., Red, Blue, Green).
* **Constraints (Rules):** Directional logic mapping relationships between options, standardizing on two primary operations:
* `EXCLUDES`: Selecting Option A disables Option B.
* `REQUIRES`: Selecting Option A restricts the target feature *only* to Option B.

## 2. The Constraint Propagation Engine

The engine models the configurator as a **Constraint Satisfaction Problem (CSP)**. Instead of using complex multi-pass brute-forcing, it implements a efficient **Forward Checking** mechanism.

* **Reactive Flow:** Selection Change $\rightarrow$ Rule Evaluation $\rightarrow$ Domain Pruning.
* **State Split:**
* *Mutable State:* Active selections (`Record<FeatureID, OptionID>`).
* *Derived State:* Disabled options (`Set<OptionID>`) calculated cleanly whenever mutable selections change.

## 3. The Model-Driven UI Builder

The UI layer is treated as a decoupled, **"dumb" presentation layer** that adapts purely based on the metadata driven by the model and the computed engine state.
* **Component Registry:** Maps `uiType` string definitions (e.g., `'radio'`, `'swatches'`, `'dropdown'`) to isolated frontend components.
* **State Handling:** Integrated into a unified state manager (e.g., Zustand or Pinia).
* **Encapsulation:** Components accept `currentSelection` and `disabledOptions` as inputs and fire strict selection events upward without modifying state directly.

## 4. Key Architectural Decisions

### A. State Management & Purity

* **Decision:** Maintain single source of truth for choices. Do not duplicate "disabled" properties inside the base data model. Always compute disabled domains as *derived state* to prevent synchronization bugs.

### B. Conflict Resolution (UX Mechanics)

* **Hard Constraints:** Options violating current state are immediately grayed out and unclickable.
* **Soft Constraints (Recommended):** Incompatible choices remain clickable. Selecting one automatically deselects conflicting options and issues an atomic state replacement accompanied by a descriptive notification.

### C. Future Extensibility

* Design the rule structure to accommodate higher-order logic gates (`AND`, `OR`, `NOT`) or mathematical bounds (`Weight <= MaxWeight`) without altering the structural architecture of the `ConstraintEngine` evaluator loop.

# Simple model example
Company with discrete manufacturing. They produce panels, plaques or elevatator button boxes. They take aluminium sheets from 0.5mm to 10mm, they apply anodizing, matt or color treatment, print with serigraphy or digital printing depending quantities, and then machine it with punching, laser cut, or millig depending quality needed. Depending if they have to print with digital or serigraphy, the aluminium sheet format will be 1000x500mm for digital or 500x500 for seri. If pieces dont fit in the standard formats, the configurator must calculate the most optimum format for min material waste. Remember the framework must work for any kind of company, I just want to see an specific example

# Configuration process
There will be another page where the user will create the configurations during the quotation process.

Introduce parameters -> Define price batches (to compare for x quantity price or n quantity price) -> Apply contraint egine -> Visualize possible configurations (possible combinations) -> select 1 or n for the quote and create it in SAP


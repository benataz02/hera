# Historic data configuration help

In the configurator process page, I want a spliter layout where on the right the user sees helps to configure the products.

There will be 2 types of help:

## Exact help
In the model settings the user will indicate the parameters that indicate: SAP itemcode, SAP business partner. With these, the system will lookup and show the latest Sales Orders and Quotations for that item AND / OR client on the right pane.

## Similarity help
User will define a query which will map the models parameters with the query fields. The app will regularly query and store the data on its own posgredb. The program will utilize this historic data to do a similarity search by the already introduced parameters during configuration. User will define the importance, and the type of search that will be done by parameter.

The user will be able to select a result and copy the parameters directly into the configuration.

Based on these concepts, i want you to help me refine a prompt and give me ideas. Dont asume anything, ask me any doubt or explain me which options/best practices i can use given the context. The objective is to accelerate or even automate the user cpq process as much as possible. Ask many questions with all the possibilities.
import { describe, expect, it, vi } from 'vitest';
import { requireSensitiveReadConfirmation, requireWriteConfirmation } from '../../tools/b1-elicitation.js';

describe('requireSensitiveReadConfirmation', () => {
  it('returns immediately when MCP_HUMAN_CONFIRMATION_ENABLED is false', async () => {
    process.env.MCP_HUMAN_CONFIRMATION_ENABLED = 'false';

    await expect(requireSensitiveReadConfirmation({
      requestContext: {},
      entityName: 'Items',
      selectString: 'LicTradNum',
      selectedPersonalFields: ['LicTradNum']
    })).resolves.toBeUndefined();
  });

  it('requires sendRequest when confirmation is enabled', async () => {
    process.env.MCP_HUMAN_CONFIRMATION_ENABLED = 'true';

    await expect(requireSensitiveReadConfirmation({
      requestContext: {},
      entityName: 'Items',
      selectString: 'LicTradNum',
      selectedPersonalFields: ['LicTradNum']
    })).rejects.toThrow('Sensitive read blocked: this MCP client invocation does not provide server-initiated elicitation support');
  });

  it('accepts confirmed response from elicitation', async () => {
    process.env.MCP_HUMAN_CONFIRMATION_ENABLED = 'true';

    const sendRequest = vi.fn(async () => ({
      action: 'accept',
      content: { confirmed: true }
    }));

    await expect(requireSensitiveReadConfirmation({
      requestContext: { sendRequest: sendRequest as never },
      entityName: 'Items',
      selectString: 'LicTradNum',
      selectedPersonalFields: ['LicTradNum']
    })).resolves.toBeUndefined();

    expect(sendRequest).toHaveBeenCalledTimes(1);
  });
});

describe('requireWriteConfirmation', () => {
  it('masks personal field values in confirmation prompts', async () => {
    process.env.MCP_HUMAN_CONFIRMATION_ENABLED = 'true';

    const sendRequest = vi.fn(async () => ({
      action: 'accept',
      content: { confirmed: true }
    }));

    await expect(requireWriteConfirmation({
      requestContext: { sendRequest: sendRequest as never },
      operation: 'create',
      entityName: 'BusinessPartners',
      parameters: {
        CardCode: 'C20000',
        CustomerName: 'Alice Example',
        Email: 'alice@example.com'
      },
      personalFieldNames: ['CustomerName', 'Email']
    })).resolves.toBeUndefined();

    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          message: expect.stringContaining('FIELDS: CardCode: C20000, CustomerName: [Personal Field], Email: [Personal Field]')
        })
      }),
      expect.anything()
    );
  });
});

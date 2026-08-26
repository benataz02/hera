import { AsyncLocalStorage } from 'node:async_hooks';

export interface B1RequestContext {
    requestId: string;
    token?: string;
    companyId?: string;
    userName?: string;
    sourceIp?: string;
}

const requestContextStore = new AsyncLocalStorage<B1RequestContext>();

export function runWithRequestContext<T>(
    context: B1RequestContext,
    fn: () => Promise<T> | T
): Promise<T> {
    return requestContextStore.run(Object.freeze({ ...context }), () => Promise.resolve(fn()));
}

export function getRequestContext(): B1RequestContext | undefined {
    return requestContextStore.getStore();
}

export function setRequestContextCompanyId(companyId?: string): void {
    const currentContext = requestContextStore.getStore();
    if (!currentContext) return;

    requestContextStore.enterWith(Object.freeze({
        ...currentContext,
        companyId
    }));
}

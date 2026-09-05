/**
 * SLD company list helper — used by integration tests.
 */

export interface B1Company {
    CompanyID: string;
    CompanySchemaName: string;
    CompanyName: string;
    Status: string;
}

export async function fetchCompanyList(accessToken: string): Promise<B1Company[]> {
    const sldRootUrl = process.env.SLD_ROOT_URL;
    if (!sldRootUrl) throw new Error('SLD_ROOT_URL is required to fetch the company list');

    const url = `${sldRootUrl}/sld/sld0100.svc/CurrentUserInfo?IncludeB1UserBinding=true`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`SLD request failed (${res.status}): ${await res.text()}`);

    type SldResponse = { d?: { CurrentUserInfo?: { B1UserBindings?: { results?: Record<string, unknown>[] } } } };
    const data = await res.json() as SldResponse;
    const results: Record<string, unknown>[] = data.d?.CurrentUserInfo?.B1UserBindings?.results ?? [];

    return results.map(item => ({
        CompanyID: (item.CompanyID as string) ?? '',
        CompanySchemaName: (item.CompanySchemaName as string) ?? '',
        CompanyName: (item.CompanyDisplayName as string) ?? '',
        Status: item.Confirmed ? 'Confirmed' : 'Unconfirmed',
    }));
}

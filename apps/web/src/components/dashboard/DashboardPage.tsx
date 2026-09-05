import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AnalyticalCardHeader, Button, Card, CardHeader, FlexBox, HeroBanner, Link, List,
  ListItemStandard, MessageStrip, NumericSideIndicator, Select, Option, Text, Toolbar, ToolbarSpacer,
} from "@ui5/webcomponents-react";
import { BarChart } from "@ui5/webcomponents-react-charts";
import { meQuery } from "../../orpc.ts";
import { orpc } from "../../orpc.ts";
import { greeting, money, nextActions, percent, scaled, trendOf } from "./dashboardView.ts";

const WINDOWS = [
  { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" },
  { key: "year12", label: "Last 12 months" },
] as const;

const cards = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "1rem" };
const panels = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: "1rem" };

export function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [window, setWindow] = useState<"month" | "quarter" | "year12">("month");
  const [ageFilter, setAgeFilter] = useState<string | null>(null);

  const { data: me } = useQuery(meQuery);
  const o = useQuery(orpc.dashboard.overview.queryOptions({ input: { window } }));
  const refresh = useMutation(orpc.dashboard.refresh.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: orpc.dashboard.overview.queryOptions({ input: { window } }).queryKey }),
  }));

  const firstName = (me?.user?.name ?? me?.user?.email ?? "there").split(/[ @]/)[0]!;

  if (!o.data) return <Card loading style={{ height: "12rem" }} />;
  const d = o.data;
  const cur = d.currency;
  const orderValue = scaled(d.orderValue.total);
  const heraValue = scaled(d.orderValue.hera);
  const bucketDocEntries = new Set(d.pipeline.find((p) => p.bucket === ageFilter)?.docEntries ?? []);
  const attention = ageFilter
    ? d.attention.filter((a) => a.docEntry !== null && bucketDocEntries.has(a.docEntry))
    : d.attention;

  return (
    <FlexBox direction="Column" style={{ gap: "1rem", padding: "1rem" }}>
      <HeroBanner
        overlineText={`${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}${
          d.computedAt ? ` · SAP data as of ${new Date(d.computedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""
        }`}
        headerText={greeting(new Date(), firstName)}
        actions={<Button icon="add" design="Emphasized" onClick={() => navigate({ to: "/configs" })}>New configuration</Button>}
      >
        <FlexBox direction="Column" style={{ gap: "0.25rem" }}>
          {nextActions(d).map((a) => (
            <Link key={a.text} onClick={() => navigate({ to: a.to })}>{a.text}</Link>
          ))}
        </FlexBox>
      </HeroBanner>

      <Toolbar>
        <Select value={window} onChange={(e) => setWindow((e.detail.selectedOption as HTMLElement).dataset.key as typeof window)}>
          {WINDOWS.map((w) => <Option key={w.key} data-key={w.key} value={w.key}>{w.label}</Option>)}
        </Select>
        <ToolbarSpacer />
        <Button icon="refresh" disabled={refresh.isPending} onClick={() => refresh.mutate(undefined)} />
      </Toolbar>

      {(refresh.error || d.snapshotError || !d.computedAt) && (
        <MessageStrip design="Critical" hideCloseButton>
          {refresh.error
            ? refresh.error.message
            : d.snapshotError
              ? `SAP figures could not be refreshed: ${d.snapshotError}`
              : "SAP figures have not been collected yet."}
        </MessageStrip>
      )}

      <div style={cards}>
        <Card header={
          <AnalyticalCardHeader
            titleText="Order value" subtitleText={WINDOWS.find((w) => w.key === window)!.label}
            value={orderValue.value} scale={`${orderValue.scale} ${cur}`}
            trend={trendOf(d.orderValue.total, d.orderValue.prevTotal)} state="Good"
          >
            <NumericSideIndicator titleText="via HERA" number={heraValue.value} unit={`${heraValue.scale} ${cur}`} />
          </AnalyticalCardHeader>
        } />
        <Card header={
          <AnalyticalCardHeader
            titleText="Quote-to-order" subtitleText={`${d.conversion.converted} of ${d.conversion.quotes} quotations`}
            value={percent(d.conversion.rate)} trend={trendOf(d.conversion.rate, d.conversion.prevRate)}
          />
        } />
        <Card header={
          <AnalyticalCardHeader
            titleText="Quote turnaround" subtitleText={`median of ${d.turnaround.sampled}`}
            value={d.turnaround.medianDays === null ? "—" : d.turnaround.medianDays.toFixed(1)} scale="days"
          />
        } />
        <Card header={
          <AnalyticalCardHeader
            titleText="Configured margin" subtitleText={`${d.margin.covered} of ${d.margin.of} quotes`}
            value={percent(d.margin.pct)}
            state={d.margin.pct !== null && d.margin.pct < 0.15 ? "Critical" : "Good"}
          />
        } />
      </div>

      <div style={panels}>
        <Card header={<CardHeader titleText="Configuration → order" />}>
          <BarChart
            dimensions={[{ accessor: "stage" }]}
            measures={[{ accessor: "count", label: "Configurations" }]}
            dataset={d.funnel}
            noLegend
          />
        </Card>
        <Card header={<CardHeader titleText="Open pipeline by age" />}>
          <BarChart
            dimensions={[{ accessor: "bucket" }]}
            measures={[{
              accessor: "value", label: `Open value (${cur})`,
              formatter: (v: number) => money(v, cur),
              highlightColor: (_v, _m, row) =>
                row.bucket === "30d+" ? "var(--sapNegativeColor)" : undefined,
            }]}
            dataset={d.pipeline}
            noLegend
            onDataPointClick={(e) => {
              const bucket = (e.detail as { payload?: { bucket?: string } }).payload?.bucket ?? null;
              setAgeFilter((prev) => (prev === bucket ? null : bucket));
            }}
          />
          {d.pipelineTruncated && (
            <Text style={{ padding: "0 1rem 0.5rem" }}>
              Showing the 1,000 most recent open quotations; older ones are not counted.
            </Text>
          )}
        </Card>
      </div>

      <div style={panels}>
        <Card header={<CardHeader titleText={ageFilter ? `Needs attention · ${ageFilter}` : "Needs attention"} />}>
          <List>
            {attention.length === 0 && <ListItemStandard>Nothing waiting on you</ListItemStandard>}
            {attention.map((a) => (
              <ListItemStandard
                key={a.id} description={a.customer ?? undefined} additionalText={`${a.ageDays}d`}
                additionalTextState="Critical" onClick={() => navigate({ to: "/configs/$id", params: { id: a.id } })}
              >
                {a.name} — {a.reason}
              </ListItemStandard>
            ))}
          </List>
        </Card>
      </div>
    </FlexBox>
  );
}

import { useEffect, useMemo } from "react"
import { AlertTriangle } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { ActiveFilterChips, FilterPopover, FilterSelect, FilterToolbar, SearchInput } from "@/components/TableFilters"
import { TablePagination } from "@/components/TablePagination"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useRepos } from "@/features/forge/api"
import { CATEGORY_OPTIONS, KIND_OPTIONS, SEVERITY_OPTIONS } from "@/features/findings/options"
import { useBacklog } from "@/features/backlog/api"
import { BacklogStatsStrip } from "@/features/backlog/BacklogStatsStrip"
import { BacklogTable } from "@/features/backlog/BacklogTable"
import { AGE_OPTIONS, BACKLOG_STATE_OPTIONS, ORIGIN_OPTIONS } from "@/features/backlog/options"
import { useBacklogFilters } from "@/features/backlog/useBacklogFilters"

export function BacklogPage() {
  const repos = useRepos()
  const repoOptions = useMemo(
    () =>
      (repos.data?.repos ?? [])
        .map((r) => ({ value: r.id, label: r.fullPath }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [repos.data],
  )
  const filters = useBacklogFilters(repoOptions)
  const { values, setters, pagination } = filters
  const { data, isPending, isError } = useBacklog(filters.params)
  // A page past the end (e.g. after dismissing the last row) falls back to the last real page.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pagination.size)) : 1
  useEffect(() => {
    if (pagination.page > lastPage) pagination.setPage(lastPage)
  }, [pagination, lastPage])

  return (
    <PageShell>
      <PageHeader
        title="Backlog"
        description="Findings that were still unaddressed when their pull or merge request merged. Later merges that fix them resolve them."
      />
      <BacklogStatsStrip />
      <FilterToolbar>
        <ActiveFilterChips filters={filters.activeFilters} />
        <FilterPopover active={filters.filtering} onClear={filters.clearFilters}>
          <FilterSelect
            id="backlog-state"
            label="State"
            allLabel="All states"
            value={values.state}
            onValueChange={setters.setState}
            options={BACKLOG_STATE_OPTIONS}
          />
          <FilterSelect
            id="backlog-origin"
            label="Origin"
            allLabel="Any origin"
            value={values.origin}
            onValueChange={setters.setOrigin}
            options={ORIGIN_OPTIONS}
          />
          <FilterSelect
            id="backlog-severity"
            label="Severity"
            allLabel="All severities"
            value={values.severity}
            onValueChange={setters.setSeverity}
            options={SEVERITY_OPTIONS}
          />
          <FilterSelect
            id="backlog-category"
            label="Category"
            allLabel="All categories"
            value={values.category}
            onValueChange={setters.setCategory}
            options={CATEGORY_OPTIONS}
          />
          <FilterSelect
            id="backlog-kind"
            label="Type"
            allLabel="All types"
            value={values.kind}
            onValueChange={setters.setKind}
            options={KIND_OPTIONS}
          />
          <FilterSelect
            id="backlog-age"
            label="Age"
            allLabel="Any age"
            value={values.age}
            onValueChange={setters.setAge}
            options={AGE_OPTIONS}
          />
          {repoOptions.length > 1 && (
            <FilterSelect
              id="backlog-repo"
              label="Repository"
              allLabel="All repositories"
              value={values.repo}
              onValueChange={setters.setRepo}
              options={repoOptions}
            />
          )}
        </FilterPopover>
        <SearchInput label="Search backlog" value={values.query} onChange={setters.setQuery} />
      </FilterToolbar>
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load the backlog.</AlertTitle>
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <BacklogTable
              items={data.items}
              sort={filters.sort}
              onSort={filters.onSort}
              emptyMessage={
                filters.narrowed
                  ? "No backlog items match your filters."
                  : "The backlog is empty. Findings still open when a change merges will show up here."
              }
            />
            {data.total > 0 && (
              <TablePagination
                page={Math.min(pagination.page, lastPage)}
                size={pagination.size}
                total={data.total}
                onPageChange={pagination.setPage}
                onSizeChange={pagination.setSize}
              />
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  )
}

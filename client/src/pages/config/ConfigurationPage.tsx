import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { AlertTriangle, Folder, FolderGit2, FolderPlus, Globe, Plus, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { SearchableSelect, type SelectOptionGroup } from "@/components/SearchableSelect"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { hasOverrides, useGlobalConfig } from "@/features/config/api"
import { DEFAULT_CONFIG_TAB, isConfigTab, type ConfigTab } from "@/features/config/tabs"
import { GlobalConfigForm } from "@/features/config/GlobalConfigForm"
import { FollowGlobalSwitch, RepoConfigForm } from "@/features/config/RepoConfigForm"
import { AddDirectoryDialog, DirectoryConfigForm, RemoveDirectoryDialog } from "@/features/config/DirectoryConfigForm"
import { directoriesOf } from "@/features/config/directories"
import { useRepos } from "@/features/forge/api"

const GLOBAL = "global"
// The folder picker's value for the repository's own settings; never a valid
// folder path, which has no leading slash.
const WHOLE_REPO = "/"

export function ConfigurationPage() {
  const repos = useRepos()
  const global = useGlobalConfig()
  const sorted = useMemo(
    () => [...(repos.data?.repos ?? [])].sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
    [repos.data],
  )

  // ?repo= keeps the selected scope linkable and ?tab= the open tab; without
  // them (or with unknown values) the global config's first tab shows.
  const [params, setParams] = useSearchParams()
  const selected = sorted.find((repo) => repo.id === params.get("repo")) ?? null
  // ?dir= picks one of the selected repository's folders.
  const directories = useMemo(() => (selected ? directoriesOf(selected) : []), [selected])
  const selectedDir = directories.find((dir) => dir.path === params.get("dir")) ?? null
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const requestedTab = params.get("tab")
  const tab = isConfigTab(requestedTab) ? requestedTab : DEFAULT_CONFIG_TAB

  const scopeOptions = useMemo<SelectOptionGroup[]>(
    () => [
      { options: [{ value: GLOBAL, label: "All repositories", icon: Globe }] },
      {
        heading: "Repositories",
        options: sorted.map((repo) => ({
          value: repo.id,
          label: repo.fullPath,
          description: repo.account.login,
          keywords: [repo.account.login],
          badge: hasOverrides(repo) && (
            <Badge variant="secondary" className="ml-auto">
              Overrides
            </Badge>
          ),
        })),
      },
    ],
    [sorted],
  )

  // Every setter keeps the tab, so switching scope stays on the same tab. A
  // new repository drops the folder, which belongs to the old one.
  function update(next: { repo?: string | null; dir?: string | null; tab?: string }) {
    const repo = next.repo === undefined ? params.get("repo") : next.repo
    const dir = next.dir === undefined && next.repo === undefined ? params.get("dir") : next.dir
    const nextTab = next.tab ?? params.get("tab")
    setParams(
      { ...(repo ? { repo } : {}), ...(repo && dir ? { dir } : {}), ...(nextTab ? { tab: nextTab } : {}) },
      { replace: true },
    )
  }

  const onTabChange = (value: ConfigTab) => update({ tab: value })

  // The forms' unsaved-changes guard watches ?repo=, so a scope switch from
  // here or from any link asks before it drops their edits.
  function selectScope(value: string) {
    if (value === (selected?.id ?? GLOBAL)) return
    update({ repo: value === GLOBAL ? null : value })
  }

  function selectDirectory(value: string) {
    if (value === (selectedDir?.path ?? WHOLE_REPO)) return
    update({ dir: value === WHOLE_REPO ? null : value })
  }

  const directoryOptions = useMemo<SelectOptionGroup[]>(
    () => [
      { options: [{ value: WHOLE_REPO, label: "Whole repository", icon: FolderGit2 }] },
      {
        heading: "Folders",
        options: directories.map((dir) => ({
          value: dir.path,
          label: dir.path,
          icon: Folder,
          badge: Object.keys(dir.settings).length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              Overrides
            </Badge>
          ),
        })),
      },
    ],
    [directories],
  )

  // The card stays mounted while the forms load, so an open scope picker is
  // not reset; a loaded form portals its Profile field into the slot.
  const [profileSlot, setProfileSlot] = useState<HTMLElement | null>(null)

  let body
  // Wait for the repository list before falling back, so a ?repo= link does not flash the global config.
  if (params.has("repo") && repos.isPending) body = <Skeleton className="h-96 w-full" />
  else if (selected && selectedDir)
    body = (
      <DirectoryConfigForm
        key={`${selected.id}:${selectedDir.path}`}
        repo={selected}
        directory={selectedDir}
        tab={tab}
        onTabChange={onTabChange}
        profileSlot={profileSlot}
      />
    )
  else if (selected)
    body = (
      <RepoConfigForm
        key={selected.id}
        repo={selected}
        tab={tab}
        onTabChange={onTabChange}
        profileSlot={profileSlot}
      />
    )
  else if (global.isPending) body = <Skeleton className="h-96 w-full" />
  else if (global.isError)
    body = (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{global.error.message}</AlertTitle>
      </Alert>
    )
  else body = <GlobalConfigForm global={global.data} tab={tab} onTabChange={onTabChange} profileSlot={profileSlot} />

  return (
    <PageShell className="@container">
      <PageHeader title="Review settings" description="Choose what reviews look for, how they are published and when they block." />
      {/* One card for what applies to every tab: the scope and the profile. */}
      <div
        role="region"
        aria-label="Scope and profile"
        className="rounded-xl border bg-muted/30 p-4 compact:p-3 spacious:p-6"
      >
        {/* Capped so each select stays a comfortable width on a wide page. The
            scope is built from the same Field parts as Profile so the two line up. */}
        <div className="grid max-w-3xl items-start gap-4 @3xl:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="config-scope">Scope</FieldLabel>
            <SearchableSelect
              id="config-scope"
              value={selected?.id ?? GLOBAL}
              onValueChange={selectScope}
              searchPlaceholder="Search repositories..."
              emptyText="No matching repositories."
              options={scopeOptions}
            />
            <FieldDescription>
              {!selected ? (
                <>
                  The global config applies to every repository. Repositories that do not follow it layer their own
                  overrides on top, and a <code>.sentryward.yaml</code> in a repository still wins over both.
                </>
              ) : selected.followGlobal ? (
                "Only the global config applies. Overrides and folders are kept for when you stop following it."
              ) : selectedDir ? (
                <>
                  Used for changes whose files are all inside <code>{selectedDir.path}</code>, on top of the
                  repository's settings and below a <code>.sentryward.yaml</code> in the repository.
                </>
              ) : (
                <>
                  Overrides saved here sit on top of the global config and below a <code>.sentryward.yaml</code> in
                  the repository.
                </>
              )}
            </FieldDescription>
            {selected && (
              <div className="flex items-center gap-2">
                <FollowGlobalSwitch repo={selected} id="follow-global" />
                <Label htmlFor="follow-global">Follow global config</Label>
              </div>
            )}
            {selected && (
              <div className="flex flex-col gap-2 pt-2">
                <Label htmlFor="config-directory">Folder</Label>
                <div className="flex items-center gap-2">
                  <SearchableSelect
                    id="config-directory"
                    className="min-w-0 flex-1"
                    value={selectedDir?.path ?? WHOLE_REPO}
                    onValueChange={selectDirectory}
                    searchPlaceholder="Search folders..."
                    emptyText="No matching folders."
                    options={directoryOptions}
                  />
                  {selectedDir ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove folder ${selectedDir.path}`}
                      onClick={() => setRemoving(true)}
                      disabled={selected.followGlobal}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => setAdding(true)} disabled={selected.followGlobal}>
                    <FolderPlus />
                    Add folder
                  </Button>
                </div>
                <AddDirectoryDialog
                  repo={selected}
                  open={adding}
                  onOpenChange={setAdding}
                  onAdded={(path) => update({ dir: path })}
                />
                {selectedDir && (
                  <RemoveDirectoryDialog
                    repo={selected}
                    path={selectedDir.path}
                    open={removing}
                    onOpenChange={setRemoving}
                    onRemoved={() => update({ dir: null })}
                  />
                )}
              </div>
            )}
            {repos.isSuccess && sorted.length === 0 && (
              <div>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/repositories">
                    <Plus />
                    Add repositories
                  </Link>
                </Button>
              </div>
            )}
            {repos.isError && <p className="text-sm text-destructive">{repos.error.message}</p>}
          </Field>
          <div ref={setProfileSlot} />
        </div>
      </div>
      {/* Full width: the tabs lay out as a side rail and the LLM and Display tabs add a panel beside their settings. */}
      <div className="flex flex-col">{body}</div>
    </PageShell>
  )
}

import { useState, type FormEvent } from "react"
import { FolderPlus, Info, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { UnsavedChangesDialog } from "@/components/UnsavedChangesDialog"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { ApiError } from "@/lib/api"
import type { DirectorySetting, ForgeRepo } from "@/features/forge/api"
import { useApiKeys } from "@/features/llm-connections/api"
import { useRepoConfig, useRulePatternErrors, useSaveRepoDirectories } from "./api"
import { ConfigFields } from "./ConfigFields"
import { SaveBar } from "./SaveBar"
import type { ConfigTab } from "./tabs"
import { directoriesOf, directoryError, normalizeDirectory } from "./directories"
import { isDirty, toForm, toSettings, validateForm, type FormState } from "./settingsForm"

function serverError(err: unknown, fallback: string) {
  const fieldError = err instanceof ApiError ? err.fieldErrors?.directories?.[0] : undefined
  return fieldError ?? (err instanceof Error ? err.message : fallback)
}

// Adds a folder with no settings of its own yet, then opens it.
export function AddDirectoryDialog(props: {
  repo: ForgeRepo
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (path: string) => void
}) {
  const save = useSaveRepoDirectories()
  const [value, setValue] = useState("")
  const [touched, setTouched] = useState(false)
  const existing = directoriesOf(props.repo)
  const path = normalizeDirectory(value)
  const error = directoryError(
    path,
    existing.map((dir) => dir.path),
  )

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (error) return
    try {
      await save.mutateAsync({ repoId: props.repo.id, directories: [...existing, { path, settings: {} }] })
      setValue("")
      setTouched(false)
      props.onOpenChange(false)
      props.onAdded(path)
    } catch (err) {
      toast.error(serverError(err, "Could not add the folder"))
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a folder</DialogTitle>
            <DialogDescription>
              A change is reviewed with a folder's settings only when every file it changes is inside that folder.
              Otherwise the repository's settings apply.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={touched && Boolean(error)}>
            <FieldLabel htmlFor="directory-path">Folder path</FieldLabel>
            <Input
              id="directory-path"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="services/billing"
              autoComplete="off"
              aria-invalid={touched && Boolean(error)}
            />
            <FieldDescription>From the repository root, without wildcards. Folders cannot be inside one another.</FieldDescription>
            {touched && error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <FolderPlus />}
              Add folder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RemoveDirectoryDialog(props: {
  repo: ForgeRepo
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved: () => void
}) {
  const save = useSaveRepoDirectories()

  async function onRemove() {
    try {
      await save.mutateAsync({
        repoId: props.repo.id,
        directories: directoriesOf(props.repo).filter((dir) => dir.path !== props.path),
      })
      props.onOpenChange(false)
      props.onRemoved()
    } catch (err) {
      toast.error(serverError(err, "Could not remove the folder"))
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {props.path}?</DialogTitle>
          <DialogDescription>
            Its settings are deleted. Changes inside it are reviewed with the repository's settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" onClick={onRemove} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Remove folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A folder's settings edit like a repository's, one layer up: an unset field
// inherits the repository's effective value, and the repository file still
// wins over both. Key by repository and path so each starts from its own
// saved settings.
export function DirectoryConfigForm(props: {
  repo: ForgeRepo
  directory: DirectorySetting
  tab: ConfigTab
  onTabChange: (tab: ConfigTab) => void
  profileSlot?: HTMLElement | null
}) {
  const { repo, directory } = props
  const resolved = useRepoConfig(repo.id, directory.path)
  const parent = useRepoConfig(repo.id)
  const save = useSaveRepoDirectories()
  const apiKeys = useApiKeys()
  const [form, setForm] = useState<FormState>(() => toForm(directory.settings))
  const dirty = isDirty(directory.settings, form) && !repo.followGlobal
  const leaving = useUnsavedChanges(dirty, ["repo", "dir"])
  const patternErrors = useRulePatternErrors(form.rules.map((rule) => rule.pattern)).data
  const errors = validateForm(
    form,
    false,
    apiKeys.data?.keys.filter((key) => key.stored).map((key) => key.provider),
    patternErrors,
    parent.data?.config.rules,
  )
  const valid = Object.keys(errors).length === 0

  async function onSave() {
    const settings = toSettings(directory.settings, form)
    try {
      await save.mutateAsync({
        repoId: repo.id,
        directories: directoriesOf(repo).map((dir) => (dir.path === directory.path ? { path: dir.path, settings } : dir)),
      })
      toast.success("Settings saved")
    } catch (err) {
      toast.error(serverError(err, "Could not save settings"))
    }
  }

  const notices = (
    <>
      {!repo.followGlobal && (
        <p className="flex gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-medium text-foreground">Inherit</strong> uses the repository's value for{" "}
            <code>{directory.path}</code>. These settings apply only to changes whose files are all inside this folder.
          </span>
        </p>
      )}
      {resolved.data && (resolved.data.repoFile || resolved.data.warnings.length > 0) && (
        <Alert>
          <AlertDescription>
            {resolved.data.repoFile && (
              <p>
                <code>{resolved.data.repoFile}</code> on <code>{resolved.data.ref}</code> also applies, and wins over
                folder settings.
              </p>
            )}
            {resolved.data.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}
    </>
  )

  return (
    <>
      <UnsavedChangesDialog open={leaving.blocked} onKeep={leaving.keep} onDiscard={leaving.discard} />
      <ConfigFields
        mode="repo"
        ownLayer="directory"
        form={form}
        onChange={setForm}
        tab={props.tab}
        onTabChange={props.onTabChange}
        profileSlot={props.profileSlot}
        config={resolved.data?.config}
        sources={resolved.data?.sources}
        inherited={parent.data?.config}
        inheritedSources={parent.data?.sources}
        repoFile={resolved.data?.repoFile}
        errors={errors}
        rulePatternErrors={patternErrors}
        disabled={repo.followGlobal}
        guidanceLabel="Folder guidance"
        notices={notices}
        footer={
          <SaveBar dirty={dirty} onDiscard={() => setForm(toForm(directory.settings))} disabled={save.isPending}>
            <Button onClick={onSave} disabled={save.isPending || repo.followGlobal || !dirty || !valid}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Save settings
            </Button>
          </SaveBar>
        }
      />
    </>
  )
}

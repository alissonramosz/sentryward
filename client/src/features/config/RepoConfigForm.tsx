import { useState } from "react"
import { Info, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { UnsavedChangesDialog } from "@/components/UnsavedChangesDialog"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { ApiError } from "@/lib/api"
import type { ForgeRepo } from "@/features/forge/api"
import { useApiKeys } from "@/features/llm-connections/api"
import { useGlobalConfig, useRepoConfig, useRulePatternErrors, useSaveRepoSettings, useSetFollowGlobal } from "./api"
import { ConfigFields } from "./ConfigFields"
import { SaveBar } from "./SaveBar"
import type { ConfigTab } from "./tabs"
import { isDirty, toForm, toSettings, validateForm, type FormState } from "./settingsForm"

export function FollowGlobalSwitch({ repo, id }: { repo: ForgeRepo; id?: string }) {
  const setFollow = useSetFollowGlobal()

  async function onChange(followGlobal: boolean) {
    try {
      await setFollow.mutateAsync({ repo, followGlobal })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the repository")
    }
  }

  return (
    <Switch
      id={id}
      checked={repo.followGlobal}
      onCheckedChange={onChange}
      aria-label={`Follow global config for ${repo.fullPath}`}
      disabled={setFollow.isPending}
    />
  )
}

// Key by repository id so each one starts from its own saved settings. The
// follow switch lives next to the scope picker; while it is on, the overrides
// here are kept but locked.
export function RepoConfigForm(props: {
  repo: ForgeRepo
  tab: ConfigTab
  onTabChange: (tab: ConfigTab) => void
  profileSlot?: HTMLElement | null
}) {
  const { repo } = props
  const resolved = useRepoConfig(repo.id)
  // An unset field falls back to the global config. If this repository picks
  // its own profile, that preset applies instead of the global one for fields
  // the global config leaves unset; the Effective line after saving is exact.
  const global = useGlobalConfig()
  const save = useSaveRepoSettings()
  const apiKeys = useApiKeys()
  const [form, setForm] = useState<FormState>(() => toForm(repo.settings))
  // As in GlobalConfigForm: the revision the form was filled from.
  const [revision, setRevision] = useState(repo.settingsRevision)
  // Edits are locked while the repository follows the global config, so
  // there is nothing to lose then.
  const dirty = isDirty(repo.settings, form) && !repo.followGlobal
  const leaving = useUnsavedChanges(dirty, ["repo", "dir"])
  const patternErrors = useRulePatternErrors(form.rules.map((rule) => rule.pattern)).data
  const errors = validateForm(
    form,
    false,
    apiKeys.data?.keys.filter((key) => key.stored).map((key) => key.provider),
    patternErrors,
    global.data?.config.rules,
    "global",
    global.data?.config.reviewers,
  )
  const valid = Object.keys(errors).length === 0

  function discard() {
    setForm(toForm(repo.settings))
    setRevision(repo.settingsRevision)
  }

  async function onSave() {
    try {
      const settings = toSettings(repo.settings, form)
      const saved = await save.mutateAsync({ repoId: repo.id, settings, settingsRevision: revision })
      setRevision(saved.repo.settingsRevision)
      toast.success("Settings saved")
    } catch (err) {
      // The server checks rules and custom reviewers against the global config
      // as saved now, which may have changed since this page loaded.
      const fields = err instanceof ApiError ? err.fieldErrors : undefined
      const listError = fields?.rules?.[0] ?? fields?.reviewers?.[0]
      toast.error(listError ?? (err instanceof Error ? err.message : "Could not save settings"))
    }
  }

  const notices = (
    <>
        {!repo.followGlobal && (
          <p className="flex gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-medium text-foreground">Inherit</strong> uses the global config's value (which
              falls back to the profile and defaults) and keeps following it when the global config changes. Choose a
              value or flip a switch to override it for this repository only.
            </span>
          </p>
        )}
        {resolved.data && (resolved.data.repoFile || resolved.data.warnings.length > 0) && (
          <Alert>
            <AlertDescription>
              {resolved.data.repoFile && (
                <p>
                  <code>{resolved.data.repoFile}</code> on <code>{resolved.data.ref}</code> also applies.
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
        form={form}
        onChange={setForm}
        tab={props.tab}
        onTabChange={props.onTabChange}
        profileSlot={props.profileSlot}
        config={resolved.data?.config}
        sources={resolved.data?.sources}
        inherited={global.data?.config}
        inheritedSources={global.data?.sources}
        repoFile={resolved.data?.repoFile}
        errors={errors}
        rulePatternErrors={patternErrors}
        disabled={repo.followGlobal}
        guidanceLabel="Repository guidance"
        notices={notices}
        footer={
          <SaveBar dirty={dirty} onDiscard={discard} disabled={save.isPending}>
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

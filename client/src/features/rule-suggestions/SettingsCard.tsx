import { useEffect, useState } from "react"
import { ChevronRight, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { TagInput } from "@/components/TagInput"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  useRuleSuggestionSettings,
  useRunRuleSuggestions,
  useSaveRuleSuggestionSettings,
  type SuggestionSettings,
} from "./api"

// Mirrors saveRuleSuggestionSettingsSchema on the server.
const MIN_EVIDENCE = 2
const MAX_EVIDENCE = 50

function statusText(settings: SuggestionSettings): string {
  if (!settings.enabled) return "Turn this on to start learning from review history."
  const comments = `${settings.storedComments} review ${settings.storedComments === 1 ? "comment" : "comments"} stored.`
  if (!settings.lastRunAt) return `A check is due and starts within about 10 minutes. ${comments}`
  const at = new Date(settings.lastRunAt)
  return `Last checked ${at.toLocaleString()}; checks run weekly. ${comments}`
}

function SettingsForm(props: { settings: SuggestionSettings; onDirtyChange: (dirty: boolean) => void }) {
  const { settings, onDirtyChange } = props
  const save = useSaveRuleSuggestionSettings()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [minEvidence, setMinEvidence] = useState(String(settings.minEvidence))
  const [excluded, setExcluded] = useState(settings.excludedReviewers)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const minValue = Number(minEvidence)
  const minError =
    !Number.isInteger(minValue) || minValue < MIN_EVIDENCE || minValue > MAX_EVIDENCE
      ? `Enter a whole number from ${MIN_EVIDENCE} to ${MAX_EVIDENCE}`
      : undefined
  const dirty =
    enabled !== settings.enabled ||
    minEvidence !== String(settings.minEvidence) ||
    excluded.join("\n") !== settings.excludedReviewers.join("\n")

  // Check now lives in the card header, outside this form, and must not run
  // against settings that are still unsaved here.
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  async function onSave() {
    if (minError) {
      setErrors({ minEvidence: minError })
      return
    }
    setErrors({})
    try {
      await save.mutateAsync({ enabled, minEvidence: minValue, excludedReviewers: excluded })
      toast.success(
        enabled ? "Saved rule suggestion settings" : "Turned rule suggestions off and deleted the stored review comments",
      )
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors) {
        setErrors(Object.fromEntries(Object.entries(error.fieldErrors).map(([key, messages]) => [key, messages?.[0] ?? ""])))
      }
      toast.error(error instanceof Error ? error.message : "Could not save the settings")
    }
  }

  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <Switch id="rule-suggestions-enabled" checked={enabled} onCheckedChange={setEnabled} />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor="rule-suggestions-enabled">Suggest rules from review history</FieldLabel>
          <FieldDescription>
            Once a week, the review model reads recent comments on changed lines and findings dismissed as false
            positives or intentional, and drafts rules for you to approve.
          </FieldDescription>
          <FieldDescription className="text-xs">
            Each check is one model call billed to this workspace, made only when something recurs. Comments are stored
            only while this is on, for at most 90 days (sooner under a shorter privacy retention); turning it off
            deletes them.
          </FieldDescription>
        </div>
      </Field>
      <div className="grid gap-6 md:grid-cols-[minmax(0,12rem)_1fr]">
        <Field data-invalid={errors.minEvidence ? true : undefined}>
          <FieldLabel htmlFor="rule-suggestions-min">Minimum evidence</FieldLabel>
          <Input
            id="rule-suggestions-min"
            type="number"
            inputMode="numeric"
            min={MIN_EVIDENCE}
            max={MAX_EVIDENCE}
            value={minEvidence}
            onChange={(e) => setMinEvidence(e.target.value)}
            aria-invalid={errors.minEvidence ? true : undefined}
          />
          <FieldDescription>Comments or dismissals, across at least two changes, a suggestion must cite.</FieldDescription>
          {errors.minEvidence && <FieldError>{errors.minEvidence}</FieldError>}
        </Field>
        <Field data-invalid={errors.excludedReviewers ? true : undefined}>
          <FieldLabel htmlFor="rule-suggestions-excluded">Reviewers not to learn from</FieldLabel>
          <TagInput
            id="rule-suggestions-excluded"
            value={excluded}
            onChange={setExcluded}
            placeholder="Forge login, then Enter"
            aria-invalid={errors.excludedReviewers ? true : undefined}
          />
          <FieldDescription>Their comments are not stored, and those already stored are deleted on save.</FieldDescription>
          {errors.excludedReviewers && <FieldError>{errors.excludedReviewers}</FieldError>}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onSave} disabled={!dirty || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          Save
        </Button>
        {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
      </div>
    </FieldGroup>
  )
}

export function SettingsCard(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const settings = useRuleSuggestionSettings()
  const run = useRunRuleSuggestions()
  const [dirty, setDirty] = useState(false)

  async function onRun() {
    try {
      await run.mutateAsync()
      toast.success("Suggestions will be checked within about 10 minutes")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start a check")
    }
  }

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange} asChild>
      <Card id="rule-suggestion-settings" className="gap-0 py-0">
        <CardHeader className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              Learning from reviews
              {settings.data && (
                <Badge
                  variant="outline"
                  className={cn(
                    settings.data.enabled
                      ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
                      : "text-muted-foreground",
                  )}
                >
                  <span className="size-1.5 rounded-full bg-current" aria-hidden />
                  {settings.data.enabled ? "On" : "Off"}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {settings.isPending ? (
                <Skeleton className="h-4 w-64" />
              ) : settings.isError ? (
                <span className="text-destructive">Could not load the settings.</span>
              ) : (
                statusText(settings.data)
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {settings.data?.enabled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRun}
                disabled={dirty || run.isPending}
                title={dirty ? "Save your changes first" : undefined}
              >
                {run.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Check now
              </Button>
            )}
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="group">
                <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                Settings
              </Button>
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        {/* Kept mounted while closed, so collapsing does not throw away unsaved edits. */}
        <CollapsibleContent forceMount hidden={!props.open}>
          <CardContent className="border-t py-6">
            {settings.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : settings.isError ? (
              <p className="text-sm text-destructive">Could not load the settings.</p>
            ) : (
              // Keyed by the saved values, so a save (or another tab's, on refetch)
              // starts the form over from them.
              <SettingsForm
                key={JSON.stringify([settings.data.enabled, settings.data.minEvidence, settings.data.excludedReviewers])}
                settings={settings.data}
                onDirtyChange={setDirty}
              />
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

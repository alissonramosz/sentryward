import { useMemo, useState } from "react"
import { Link } from "react-router"
import { Check, ChevronRight, EyeOff, Loader2, MessageSquare, X } from "lucide-react"
import { toast } from "sonner"
import { SearchableSelect } from "@/components/SearchableSelect"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useConfigSchema } from "@/features/config/api"
import { ruleRowErrors, toRule, toRuleRow, type RuleRow } from "@/features/config/settingsForm"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ForgeRepo } from "@/features/forge/api"
import { SeverityBadge } from "@/features/reviews/badges"
import { SEVERITY_BORDER } from "@/features/reviews/severity"
import type { Severity } from "@/features/reviews/types"
import { ApiError } from "@/lib/api"
import { formatDate, timeAgo } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useApproveRuleSuggestion, useDiscardRuleSuggestion, type RuleSuggestion } from "./api"

const GLOBAL = "global"
const NO_CATEGORY = "__none"
const SEVERITIES: readonly string[] = ["critical", "major", "minor", "info"] satisfies Severity[]

// Rule severities come from the server's schema as plain strings; anything
// outside the known scale falls back to a plain badge.
function isSeverity(value: string): value is Severity {
  return SEVERITIES.includes(value)
}

function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`
}

// "2 comments across 2 changes", "3 comments and 1 dismissed finding across 4 changes".
function evidenceSummary(evidence: RuleSuggestion["evidence"]) {
  const parts = [
    evidence.commentIds.length ? plural(evidence.commentIds.length, "comment") : undefined,
    evidence.findingIds.length ? plural(evidence.findingIds.length, "dismissed finding") : undefined,
  ].filter(Boolean)
  const items = parts.length ? parts.join(" and ") : "no items"
  return `Based on ${items} across ${plural(evidence.changes, "change")}`
}

function targetLabel(target: string | null, repos: ForgeRepo[]): string {
  if (!target || target === GLOBAL) return "Global settings"
  return repos.find((repo) => repo.id === target)?.fullPath ?? "A repository no longer added"
}

// The evidence as it was cited. Excerpts are people's words, shown as plain
// text; retention empties them, leaving the counts.
function Evidence({ suggestion }: { suggestion: RuleSuggestion }) {
  const { evidence } = suggestion
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2 text-sm">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group -ml-2 h-auto w-fit py-1 text-muted-foreground">
          <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
          {evidenceSummary(evidence)}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {evidence.excerpts.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {evidence.excerpts.map((excerpt, index) => {
              const Icon = excerpt.kind === "comment" ? MessageSquare : EyeOff
              return (
                <li key={index} className="rounded-md border bg-muted/30 p-3">
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                    <Icon className="size-3.5" aria-hidden />
                    <span>{excerpt.kind === "comment" ? "Comment" : "Dismissed finding"}</span>
                    <span aria-hidden>·</span>
                    <span className="break-all">
                      {excerpt.repository}#{excerpt.number}
                    </span>
                    <span aria-hidden>·</span>
                    <code className="font-mono break-all">{excerpt.file}</code>
                  </p>
                  <p className="mt-1.5 break-words whitespace-pre-wrap">{excerpt.text}</p>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground">The excerpts were removed by the workspace&apos;s retention period.</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ApproveDialog(props: {
  suggestion: RuleSuggestion
  repos: ForgeRepo[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { suggestion, repos } = props
  const approve = useApproveRuleSuggestion()
  const schema = useConfigSchema()
  const [row, setRow] = useState<RuleRow>(() => toRuleRow(suggestion.rule))
  const [target, setTarget] = useState(suggestion.repository?.id ?? GLOBAL)
  const [serverError, setServerError] = useState<string>()
  const [submitted, setSubmitted] = useState(false)
  const errors = submitted ? (ruleRowErrors([row])[0] ?? {}) : {}
  const update = (change: Partial<RuleRow>) => setRow((current) => ({ ...current, ...change }))

  const targetOptions = useMemo(
    () => [
      { value: GLOBAL, label: "Global settings", description: "Every repository" },
      ...repos
        .map((repo) => ({
          value: repo.id,
          label: repo.fullPath,
          description: repo.followGlobal ? "Follows the global settings; give it its own first" : undefined,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [repos],
  )
  const following = target !== GLOBAL && repos.find((repo) => repo.id === target)?.followGlobal

  async function onApprove() {
    setSubmitted(true)
    setServerError(undefined)
    if (Object.keys(ruleRowErrors([row])[0] ?? {}).length) return
    try {
      await approve.mutateAsync({
        id: suggestion.id,
        rule: toRule(row),
        target: target === GLOBAL ? GLOBAL : { repositoryId: target },
      })
      toast.success(`Added rule ${row.id.trim()} to ${targetLabel(target, repos)}`)
      props.onOpenChange(false)
    } catch (error) {
      const fields = error instanceof ApiError ? error.fieldErrors : undefined
      const detail = fields ? Object.values(fields).flat()[0] : undefined
      setServerError(detail ?? (error instanceof Error ? error.message : "Could not approve the suggestion"))
    }
  }

  const severityOptions = (schema.data?.severities ?? []).map((value) => ({ value, label: value }))
  const categoryOptions = [
    { value: NO_CATEGORY, label: "maintainability", description: "The default" },
    ...(schema.data?.categories ?? []).filter((value) => value !== "maintainability").map((value) => ({ value, label: value })),
  ]

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Approve rule</DialogTitle>
          <DialogDescription>
            Edit the rule if needed and choose where it goes. It is added to those settings like a rule written by hand.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="@container/field-group">
          <Field>
            <FieldLabel htmlFor="approve-target">Add to</FieldLabel>
            <SearchableSelect id="approve-target" value={target} onValueChange={setTarget} options={targetOptions} />
            {following ? (
              <div className="flex flex-col gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-sm">
                <p>
                  This repository follows the global settings, so a rule saved to its own settings would be ignored.
                  Add the rule to the global settings, or give the repository its own settings first.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setTarget(GLOBAL)}>
                    Add to global settings instead
                  </Button>
                  <Button type="button" size="sm" variant="ghost" asChild>
                    <Link to={`/configuration?repo=${target}`}>Open repository settings</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <FieldDescription>
                {target === GLOBAL
                  ? "Applies to every repository that follows the global settings."
                  : `Applies only to ${targetLabel(target, repos)}.`}
              </FieldDescription>
            )}
          </Field>
          <div className="grid gap-3 @md/field-group:grid-cols-3">
            <Field data-invalid={errors.id ? true : undefined}>
              <FieldLabel htmlFor="approve-id">Id</FieldLabel>
              <Input
                id="approve-id"
                value={row.id}
                onChange={(e) => update({ id: e.target.value })}
                className="font-mono"
                aria-invalid={errors.id ? true : undefined}
              />
              {errors.id && <FieldError>{errors.id}</FieldError>}
            </Field>
            <Field data-invalid={errors.severity ? true : undefined}>
              <FieldLabel htmlFor="approve-severity">Severity</FieldLabel>
              <SearchableSelect
                id="approve-severity"
                value={row.severity || undefined}
                onValueChange={(severity) => update({ severity })}
                options={severityOptions}
              />
              {errors.severity && <FieldError>{errors.severity}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="approve-category">Category</FieldLabel>
              <SearchableSelect
                id="approve-category"
                value={row.category || NO_CATEGORY}
                onValueChange={(category) => update({ category: category === NO_CATEGORY ? "" : category })}
                options={categoryOptions}
              />
            </Field>
          </div>
          <Field data-invalid={errors.description ? true : undefined}>
            <FieldLabel htmlFor="approve-description">Description</FieldLabel>
            <Textarea
              id="approve-description"
              value={row.description}
              onChange={(e) => update({ description: e.target.value })}
              rows={3}
              aria-invalid={errors.description ? true : undefined}
            />
            {errors.description && <FieldError>{errors.description}</FieldError>}
          </Field>
          <div className="grid gap-3 @md/field-group:grid-cols-2">
            <Field data-invalid={errors.paths ? true : undefined}>
              <FieldLabel htmlFor="approve-paths">Paths</FieldLabel>
              <Textarea
                id="approve-paths"
                value={row.paths}
                onChange={(e) => update({ paths: e.target.value })}
                rows={2}
                className="font-mono"
              />
              <FieldDescription>One glob per line; empty covers every reviewed file.</FieldDescription>
              {errors.paths && <FieldError>{errors.paths}</FieldError>}
            </Field>
            <Field data-invalid={errors.pattern ? true : undefined}>
              <FieldLabel htmlFor="approve-pattern">Pattern</FieldLabel>
              <Input
                id="approve-pattern"
                value={row.pattern}
                onChange={(e) => update({ pattern: e.target.value })}
                className="font-mono"
                aria-invalid={errors.pattern ? true : undefined}
              />
              <FieldDescription>Optional regular expression over added lines (RE2).</FieldDescription>
              {errors.pattern && <FieldError>{errors.pattern}</FieldError>}
            </Field>
          </div>
          {serverError && <p className="text-sm text-destructive" role="alert">{serverError}</p>}
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={onApprove} disabled={approve.isPending || Boolean(following)}>
            {approve.isPending && <Loader2 className="animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DiscardDialog(props: {
  ruleId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  pending: boolean
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Discard suggestion?</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{props.ruleId}</code> will move to Discarded and will not be suggested again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={props.onConfirm} disabled={props.pending}>
            {props.pending && <Loader2 className="animate-spin" />}
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StatusLine({ suggestion, repos }: { suggestion: RuleSuggestion; repos: ForgeRepo[] }) {
  const at = suggestion.decidedAt ?? suggestion.createdAt
  const text =
    suggestion.status === "pending"
      ? `Suggested for ${targetLabel(suggestion.repository?.id ?? null, repos)}`
      : suggestion.status === "approved"
        ? `Added to ${targetLabel(suggestion.appliedTarget, repos)}`
        : "Discarded"
  return (
    <>
      {text}
      {" · "}
      <time dateTime={at} title={formatDate(at)}>
        {timeAgo(at)}
      </time>
    </>
  )
}

export function SuggestionCard({ suggestion, repos }: { suggestion: RuleSuggestion; repos: ForgeRepo[] }) {
  const [approving, setApproving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const discard = useDiscardRuleSuggestion()
  const { rule } = suggestion
  const severity = isSeverity(rule.severity) ? rule.severity : undefined

  async function onDiscard() {
    try {
      await discard.mutateAsync(suggestion.id)
      setDiscarding(false)
      toast.success(`Discarded ${rule.id}; it will not be suggested again`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not discard the suggestion")
    }
  }

  return (
    <Card
      className={cn("border-l-4", severity ? SEVERITY_BORDER[severity] : "border-l-border", suggestion.status === "discarded" && "opacity-80")}
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <code className="font-mono break-all">{rule.id}</code>
          {severity ? <SeverityBadge severity={severity} /> : <Badge variant="outline">{rule.severity}</Badge>}
          {rule.category && <Badge variant="outline">{rule.category}</Badge>}
          {rule.pattern !== undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" tabIndex={0} className="cursor-help">
                  pattern check
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Matched against added lines without a model</TooltipContent>
            </Tooltip>
          )}
        </CardTitle>
        <CardDescription>
          <StatusLine suggestion={suggestion} repos={repos} />
        </CardDescription>
        {suggestion.status === "pending" && (
          <CardAction className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDiscarding(true)}>
              <X />
              Discard
            </Button>
            <Button type="button" size="sm" onClick={() => setApproving(true)}>
              <Check />
              Approve…
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm break-words whitespace-pre-wrap">{rule.description}</p>
        {suggestion.rationale && (
          <div className="rounded-md border-l-2 border-primary/40 bg-muted/40 px-3 py-2 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Why this rule</p>
            <p className="mt-0.5 break-words">{suggestion.rationale}</p>
          </div>
        )}
        {(rule.paths?.length || rule.pattern) && (
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-2 text-sm">
            {rule.paths?.length ? (
              <>
                <dt className="text-muted-foreground">Paths</dt>
                <dd className="flex min-w-0 flex-wrap gap-1">
                  {rule.paths.map((path) => (
                    <Badge key={path} variant="outline" className="font-mono break-all whitespace-normal">
                      {path}
                    </Badge>
                  ))}
                </dd>
              </>
            ) : null}
            {rule.pattern ? (
              <>
                <dt className="text-muted-foreground">Pattern</dt>
                <dd className="min-w-0">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">{rule.pattern}</code>
                </dd>
              </>
            ) : null}
          </dl>
        )}
        <Evidence suggestion={suggestion} />
      </CardContent>
      {approving && <ApproveDialog suggestion={suggestion} repos={repos} open={approving} onOpenChange={setApproving} />}
      <DiscardDialog
        ruleId={rule.id}
        open={discarding}
        onOpenChange={setDiscarding}
        onConfirm={onDiscard}
        pending={discard.isPending}
      />
    </Card>
  )
}

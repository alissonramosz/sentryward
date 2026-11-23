import { useState } from "react"
import { Link } from "react-router"
import { FlaskConical, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { SearchableSelect } from "@/components/SearchableSelect"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useStartTrial } from "@/features/reviews/api"
import { ApiError } from "@/lib/api"
import type { CustomReviewer } from "./api"
import {
  MAX_REVIEWERS,
  newReviewerRow,
  reviewerIdFrom,
  reviewerRowErrors,
  reviewerRowValid,
  toReviewer,
  type ReviewerRow,
} from "./settingsForm"

// The select's stand-in for "use review.severityFloor".
const SAME_FLOOR = "__same"

// Custom reviewers another layer sets, with that layer.
function ReviewerList(props: { reviewers: CustomReviewer[]; sources?: Record<string, string>; sourceLabel: (source: string) => string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">Inherited</p>
      <ul className="flex flex-col gap-1 text-sm">
        {props.reviewers.map((reviewer) => {
          const source = props.sources?.[`reviewers.${reviewer.id}`]
          return (
            <li key={reviewer.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{reviewer.name}</span>
              <code className="font-mono text-xs text-muted-foreground">{reviewer.id}</code>
              <span className="text-muted-foreground">
                {reviewer.enabled === false && "off · "}
                {reviewer.paths?.length ? reviewer.paths.join(", ") : "every file"}
                {source && ` (from ${props.sourceLabel(source)})`}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// Runs one row, as it stands in the form, on a real change without posting
// anything; the result opens on the review page.
function TrialForm(props: { row: ReviewerRow; n: number; disabled?: boolean }) {
  const [url, setUrl] = useState("")
  const [reviewId, setReviewId] = useState<string>()
  const start = useStartTrial()
  const ready = reviewerRowValid(props.row)

  async function onTry() {
    try {
      const { review } = await start.mutateAsync({ url: url.trim(), reviewer: toReviewer(props.row) })
      setReviewId(review.id)
    } catch (err) {
      toast.error(err instanceof ApiError ? (err.fieldErrors?.url?.[0] ?? err.message) : "Could not start the trial")
    }
  }

  return (
    <Field>
      <FieldLabel htmlFor={`reviewer-${props.n}-trial`}>Try on a pull or merge request</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={`reviewer-${props.n}-trial`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/acme/web/pull/42"
          disabled={props.disabled}
        />
        <Button
          type="button"
          variant="outline"
          onClick={onTry}
          disabled={props.disabled || !ready || !url.trim() || start.isPending}
        >
          <FlaskConical />
          Try it
        </Button>
      </div>
      <FieldDescription>
        Reviews the change with this reviewer as it is above, saved or not. Nothing is posted to the change, and the run
        uses the workspace's model budget.
        {reviewId && (
          <>
            {" "}
            <Link to={`/reviews/${reviewId}`} className="underline underline-offset-4">
              Open the trial
            </Link>
          </>
        )}
      </FieldDescription>
    </Field>
  )
}

export function ReviewersField(props: {
  rows: ReviewerRow[]
  onChange: (rows: ReviewerRow[]) => void
  isRepo: boolean
  severities: string[]
  // The custom reviewers from the layers below, which these add to.
  inherited?: CustomReviewer[]
  inheritedSources?: Record<string, string>
  sourceLabel: (source: string) => string
  error?: string
  disabled?: boolean
  // Trials are for those who may save settings.
  canTry?: boolean
}) {
  const { rows } = props
  const rowErrors = reviewerRowErrors(rows)
  const update = (index: number, change: Partial<ReviewerRow>) =>
    props.onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)))
  const inheritedIds = new Map((props.inherited ?? []).map((r) => [r.id, props.inheritedSources?.[`reviewers.${r.id}`]]))
  const floorOptions = [
    { value: SAME_FLOOR, label: "Same as the review", description: "The severity floor on the Finding Types tab" },
    ...props.severities.map((value) => ({ value, label: value })),
  ]
  const total = (props.inherited?.length ?? 0) + rows.length

  return (
    <FieldSet data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLegend variant="label">Custom reviewers</FieldLegend>
      <FieldDescription>
        Extra reviewers with instructions of your own, each reviewing the files it covers in a pass of its own. Their
        comments are tagged with their name. Every reviewer adds a model call per pass of a change it covers.{" "}
        {props.isRepo
          ? "Added to the global config's reviewers. The repository file can add more but not replace these."
          : "Applied to every repository. Repository settings and files can add reviewers but not replace these."}
      </FieldDescription>
      {props.inherited && props.inherited.length > 0 && (
        <ReviewerList reviewers={props.inherited} sources={props.inheritedSources} sourceLabel={props.sourceLabel} />
      )}
      {rows.map((row, index) => {
        const errors = rowErrors[index] ?? {}
        const n = index + 1
        const shadowedBy = inheritedIds.get(row.id.trim())
        return (
          <div key={row.key} className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <div className="grid flex-1 gap-3 @md/field-group:grid-cols-2">
                <Field data-invalid={errors.name ? true : undefined}>
                  <FieldLabel htmlFor={`reviewer-${n}-name`}>Name</FieldLabel>
                  <Input
                    id={`reviewer-${n}-name`}
                    value={row.name}
                    onChange={(e) => {
                      const name = e.target.value
                      // The id follows the name until someone types one.
                      const follows = !row.id || row.id === reviewerIdFrom(row.name)
                      update(index, { name, ...(follows ? { id: reviewerIdFrom(name) } : {}) })
                    }}
                    placeholder="API contracts"
                    disabled={props.disabled}
                    aria-invalid={errors.name ? true : undefined}
                  />
                  {errors.name && <FieldError>{errors.name}</FieldError>}
                </Field>
                <Field data-invalid={errors.id ? true : undefined}>
                  <FieldLabel htmlFor={`reviewer-${n}-id`}>Id</FieldLabel>
                  <Input
                    id={`reviewer-${n}-id`}
                    value={row.id}
                    onChange={(e) => update(index, { id: e.target.value })}
                    placeholder="api-contracts"
                    className="font-mono"
                    disabled={props.disabled}
                    aria-invalid={errors.id ? true : undefined}
                  />
                  {errors.id && <FieldError>{errors.id}</FieldError>}
                  {!errors.id && inheritedIds.has(row.id.trim()) && (
                    <FieldDescription className="text-destructive">
                      {shadowedBy ? `The ${props.sourceLabel(shadowedBy)}` : "An inherited reviewer"} already uses this id,
                      so that reviewer applies instead of this one.
                    </FieldDescription>
                  )}
                </Field>
              </div>
              <div className="flex items-center gap-1 pt-6">
                <Switch
                  aria-label={`Reviewer ${n} enabled`}
                  checked={row.enabled}
                  onCheckedChange={(enabled) => update(index, { enabled })}
                  disabled={props.disabled}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove reviewer ${n}`}
                  onClick={() => props.onChange(rows.filter((_, i) => i !== index))}
                  disabled={props.disabled}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <Field data-invalid={errors.instructions ? true : undefined}>
              <FieldLabel htmlFor={`reviewer-${n}-instructions`}>Looks for</FieldLabel>
              <Textarea
                id={`reviewer-${n}-instructions`}
                value={row.instructions}
                onChange={(e) => update(index, { instructions: e.target.value })}
                placeholder="Response shapes that change without a version bump, and handlers that return fields the client does not expect."
                rows={3}
                disabled={props.disabled}
                aria-invalid={errors.instructions ? true : undefined}
              />
              <FieldDescription>One kind of problem works best: this reviewer reports nothing else.</FieldDescription>
              {errors.instructions && <FieldError>{errors.instructions}</FieldError>}
            </Field>
            <div className="grid gap-3 @md/field-group:grid-cols-3">
              <Field data-invalid={errors.paths ? true : undefined}>
                <FieldLabel htmlFor={`reviewer-${n}-paths`}>Paths</FieldLabel>
                <Textarea
                  id={`reviewer-${n}-paths`}
                  value={row.paths}
                  onChange={(e) => update(index, { paths: e.target.value })}
                  placeholder="server/src/routes/**"
                  rows={2}
                  className="font-mono"
                  disabled={props.disabled}
                />
                <FieldDescription>One glob per line; empty covers every reviewed file.</FieldDescription>
                {errors.paths && <FieldError>{errors.paths}</FieldError>}
              </Field>
              <Field>
                <FieldLabel htmlFor={`reviewer-${n}-floor`}>Severity floor</FieldLabel>
                <SearchableSelect
                  id={`reviewer-${n}-floor`}
                  value={row.severityFloor || SAME_FLOOR}
                  onValueChange={(floor) => update(index, { severityFloor: floor === SAME_FLOOR ? "" : floor })}
                  options={floorOptions}
                  disabled={props.disabled}
                />
              </Field>
              <Field data-invalid={errors.maxFindings ? true : undefined}>
                <FieldLabel htmlFor={`reviewer-${n}-max`}>Finding limit</FieldLabel>
                <Input
                  id={`reviewer-${n}-max`}
                  inputMode="numeric"
                  value={row.maxFindings}
                  onChange={(e) => update(index, { maxFindings: e.target.value })}
                  placeholder="No limit"
                  disabled={props.disabled}
                  aria-invalid={errors.maxFindings ? true : undefined}
                />
                <FieldDescription>Most severe first.</FieldDescription>
                {errors.maxFindings && <FieldError>{errors.maxFindings}</FieldError>}
              </Field>
            </div>
            {props.canTry && <TrialForm row={row} n={n} disabled={props.disabled} />}
          </div>
        )
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.onChange([...rows, newReviewerRow()])}
          disabled={props.disabled || total >= MAX_REVIEWERS}
        >
          <Plus />
          Add reviewer
        </Button>
      </div>
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

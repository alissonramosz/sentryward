import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { EyeOff, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
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
import { Textarea } from "@/components/ui/textarea"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useSetBacklogState } from "./api"
import type { BacklogItem } from "./types"

const NOTE_MAX = 1000

const dismissSchema = z.object({
  note: z.string().trim().max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters`),
})
type DismissInput = z.infer<typeof dismissSchema>

// Dismissing takes an item out of the backlog for good (shipping the same
// problem again leaves it dismissed), so it asks why, for whoever looks later.
export function DismissBacklogDialog({
  item,
  onOpenChange,
}: {
  item: Pick<BacklogItem, "id" | "title"> | null
  onOpenChange: (open: boolean) => void
}) {
  const setState = useSetBacklogState()
  const form = useForm<DismissInput>({ resolver: zodResolver(dismissSchema), defaultValues: { note: "" } })

  function handleOpenChange(next: boolean) {
    onOpenChange(next)
    if (!next) form.reset()
  }

  async function onSubmit({ note }: DismissInput) {
    if (!item) return
    try {
      await setState.mutateAsync({ id: item.id, state: "dismissed", ...(note ? { note } : {}) })
      toast.success("Backlog item dismissed")
      handleOpenChange(false)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <Dialog open={item !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Dismiss this backlog item?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{item?.title}</span> leaves the backlog and stays
              dismissed if it ships again, until you reopen it.
            </DialogDescription>
          </DialogHeader>
          <Controller
            control={form.control}
            name="note"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="dismiss-note">
                  Why is it not worth fixing? <span className="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Textarea
                  {...field}
                  id="dismiss-note"
                  rows={4}
                  maxLength={NOTE_MAX}
                  placeholder="e.g. This module is being replaced next quarter."
                  aria-invalid={fieldState.invalid}
                />
                <FieldDescription>Saved with the item, so others can see why it was dismissed.</FieldDescription>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <EyeOff />}
              Dismiss item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

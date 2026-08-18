import { SubjectIsolator } from "@/components/subject-isolator"
import { Scissors } from "lucide-react"

export default function Page() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-10 sm:px-6 sm:py-16">
      <header className="mb-8 sm:mb-12">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
          <Scissors className="size-3.5 text-primary" />
          Runs entirely in your browser
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground text-balance sm:text-4xl">
          Isolate any subject on white
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground text-pretty">
          Upload a photo and we&apos;ll remove the background, trim the empty space, and place your subject on a clean
          white canvas with even padding.
        </p>
      </header>

      <section className="flex-1">
        <SubjectIsolator />
      </section>

      <footer className="mt-12 border-t border-border pt-6 text-xs text-muted-foreground">
        Images never leave your device. Processing happens locally using an on-device model.
      </footer>
    </main>
  )
}

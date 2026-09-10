import Link from "next/link";

export default function SignupIntro({ returning = false, children }: {
  returning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-6xl gap-12 py-10 sm:py-20 lg:grid-cols-[1.2fr_1fr] lg:items-center lg:gap-20">
      <div>
        <h1 className="max-w-xl font-heading text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">
          {returning ? "Your next chapter is waiting." : "A job search built around you."}
        </h1>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink/70">
          Find opportunities that fit your experience, your priorities, and where you want to go next.
        </p>
        <dl className="mt-10 space-y-6">
          {[
            ["Discover the right opportunities", "Search for roles and employers using your career goals."],
            ["Understand the fit", "See how each role matches your background, with a score and an explanation."],
            ["Keep your search together", "Track companies, save jobs, and follow your next steps in one place."],
          ].map(([title, description]) => (
            <div key={title} className="border-l-2 border-ink/20 pl-5">
              <dt className="font-heading font-semibold">{title}</dt>
              <dd className="mt-1 max-w-md text-sm leading-relaxed text-ink/60">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
      <section className="rounded-2xl border border-slate bg-white p-7 sm:p-10">
        <h2 className="font-heading text-2xl font-semibold">{returning ? "Welcome back" : "Create your account"}</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink/70">
          {returning ? "Sign in to pick up your search." : "Start with Google. Then tell us about your career and choose what you want in your next role."}
        </p>
        {children}
        <div className="mt-6 rounded-lg bg-canvas p-4 text-sm leading-relaxed text-ink/70">
          <p className="font-medium text-ink">Bring your own AI API key</p>
          <p className="mt-1">Connect an Anthropic, OpenAI, or Google Gemini key during setup. Usage is billed by your chosen provider; no AI usage is included by this app.</p>
        </div>
        <p className="mt-6 text-center text-sm text-ink/60">
          {returning ? "New here? " : "Already have an account? "}
          <Link className="font-medium text-ink underline underline-offset-4" href={returning ? "/signin" : "/signin?mode=login"}>
            {returning ? "Sign up" : "Sign in"}
          </Link>
        </p>
      </section>
    </div>
  );
}

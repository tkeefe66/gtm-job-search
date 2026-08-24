import type { ResumeData } from "@/components/resume/ResumeDocument";

/**
 * Sample content for the temporary /resume-preview verification route
 * (app/resume-preview/page.tsx) — transcribed verbatim from
 * ui_kits/resume/index.html (the "Blended" variant) in the "My Resume
 * Design System" Claude Design project, not placeholder data.
 *
 * Deliberately kept under lib/__fixtures__/, not app/ or components/: the
 * resume builder is an intentionally single-owner, isAdmin-gated feature
 * (docs/superpowers/specs/2026-08-24-resume-builder-design.md), so the app
 * owner's real name is legitimate content here — unlike everywhere else in
 * app/ or components/, where it would be a career-neutrality violation.
 * lib/career-neutrality.test.ts's "previous owner" guard is scoped to
 * app/ and components/ for exactly this reason (see its own comment,
 * which already carries the precedent: lib/__fixtures__/fit-golden-set.json
 * legitimately keeps the name for the same reason).
 */
export const SAMPLE_RESUME: ResumeData = {
  contact: {
    name: "Tom Keefe",
    tagline:
      "GTM operations leader — strategy, technical pre-sales, and the AI systems behind both",
    location: "Denver, CO",
    phone: "(617) 939-7239",
    email: "tkeefe66@gmail.com",
    links: [
      { label: "Website", href: "https://tomkeefe.ai" },
      { label: "LinkedIn", href: "https://www.linkedin.com/in/tomkeefesmc" },
      { label: "GitHub", href: "https://github.com/tkeefe66" },
    ],
  },
  summary:
    "Senior GTM and marketing operations leader, 13+ years turning strategy, data, and technology into revenue. Builds the expert functions between Product and the field — pre-sales, playbooks, evangelism — and ships the AI systems behind them.",
  workHistory: [
    {
      id: "demandbase-director-gtm",
      title: "Director of GTM Experts",
      org: "Demandbase",
      locationLine: "Remote — San Francisco, CA",
      dates: "July 2025 – Present",
      bullets: [
        "Directs a global team of GTM and Data Solution Experts — digital marketing, B2B advertising, ABX, data — on strategies that shaped **$50M+ in won revenue**.",
        "Owns the Data Solution Experts function end to end: a technical pre-sales practice architecting how prospects activate the data offering inside their lake, CDP, and BI stack.",
        "Owns the GTM Playbook program — a **30+ playbook** library spanning the full product suite, adopted across Sales, Customer Success, and Partners.",
        "Launched **Ads Assist**, a three-month trial motion converting **60%+ of participants** into customers and now a repeatable field play.",
        "Built the market-presence motion around live speaking and executive forums; the org has generated **$25M+ in influenced pipeline**.",
        "Builds and ships internal AI systems in **Claude Code** — an agent matching Gong recordings to Salesforce opportunities behind a Slack approval gate, and a conversational Slack-to-Salesforce updater — deployed on Railway and Vercel.",
      ],
    },
    {
      id: "demandbase-principal-gtm",
      title: "Principal GTM Expert (Strategy & Operations)",
      org: "Demandbase",
      locationLine: "Remote — San Francisco, CA",
      dates: "April 2024 – June 2025",
      bullets: [
        "Primary GTM operations, technology, and strategy advisor to enterprise prospects — **$7M+ in influenced closed revenue** across Palo Alto Networks, T-Mobile, Verizon, and Comcast.",
        "Founded the GTM Playbook program and authored much of the library, codifying workflow architectures across the full product suite.",
        "Voice of the customer, synthesizing user and leader feedback into insight that shaped Product and Engineering roadmaps.",
        "Live-event thought-leadership ambassador, personally generating **$5M+ in influenced pipeline**.",
        "Partnered with Technology Partnerships and Product to shape joint value propositions and co-create integration concepts.",
      ],
    },
    {
      id: "demandbase-sr-director-mktg-ops",
      title: "Sr. Director of Marketing Operations",
      org: "Demandbase",
      locationLine: "Remote — San Francisco, CA",
      dates: "April 2021 – March 2024",
      bullets: [
        "Owned global go-to-market technology, data, and analytics behind a **$100M+** pipeline engine.",
        "Scaled Marketing Operations from 2 FTEs to an **8-person** multi-level team across Programs, Analytics, Technology, and Data.",
        "Led the InsideView and DemandMatrix acquisition migrations in **3 months**; established SFDC as the single source of truth.",
        "Defined the shift from single- to multi-product GTM, expanding the suite from two offerings to five and standing up a new sales team.",
      ],
    },
    {
      id: "demandbase-director-mktg-ops-1",
      title: "Director of Marketing Operations",
      org: "Demandbase",
      locationLine: "Remote — San Francisco, CA",
      dates: "June 2020 – April 2021",
      bullets: [
        "Led the Engagio-to-Demandbase migration in **2.5 months** and Pardot-to-Marketo in under three; named 2020 **Marketer of the Year**.",
        "Partnered with Product and Engineering to merge Engagio and Demandbase into one platform (ABX Cloud); lead contributor to QA and roadmap input.",
      ],
    },
    {
      id: "engagio-director-mktg-ops",
      title: "Director of Marketing Operations",
      org: "Engagio",
      locationLine: "Onsite — San Mateo, CA",
      acquisitionNote: "(acquired by Demandbase)",
      dates: "August 2019 – June 2020",
      bullets: [
        "Lifted qualified-lead-to-pipeline conversion from **28% to 53%** with discovery-based forms and sharper Sales outreach.",
      ],
    },
    {
      id: "streamsets",
      title: "Sr. Marketing Technology & Operations Manager",
      org: "StreamSets · San Francisco",
      locationLine: "",
      dates: "2018 – 2019",
      bullets: [],
    },
    {
      id: "ayla-networks",
      title: "Global Technology & Operations Manager",
      org: "Ayla Networks · Santa Clara, CA",
      locationLine: "",
      dates: "2016 – 2018",
      bullets: [],
    },
    {
      id: "goji",
      title: "Marketing Automation Manager",
      org: "Goji · Boston, MA",
      locationLine: "",
      dates: "2015 – 2016",
      bullets: [],
    },
    {
      id: "ptc",
      title: "Marketing Automation Specialist",
      org: "PTC · Boston, MA",
      locationLine: "",
      dates: "2013 – 2014",
      bullets: [],
    },
    {
      id: "wb-mason",
      title: "Education Market Analyst; School Bids Analyst",
      org: "W.B. Mason · Brockton, MA",
      locationLine: "",
      dates: "2011 – 2013",
      bullets: [],
    },
  ],
  advisory: [
    {
      id: "scale-venture-partners",
      title: "GTM Advisor",
      org: "Scale Venture Partners · San Francisco, CA",
      dates: "May 2023 – Present",
    },
    {
      id: "sendoso",
      title: "Advisor",
      org: "Sendoso · San Francisco, CA",
      dates: "March 2022 – Present",
    },
  ],
  education: [
    {
      id: "saint-michaels",
      title: "B.S. Business Administration",
      org: "Saint Michael’s College, Colchester, VT",
      dates: "2007 – 2011",
    },
  ],
};

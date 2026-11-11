import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Baby, Cookie, Database, Eye, FileText, LockKeyhole, Mail, Scale, Share2, ShieldCheck, UserRound } from 'lucide-react';
import { absoluteUrl } from '@/lib/seo/site';

const description='How GoodSale collects, uses, and protects your personal data across the marketplace and escrow service.';
export const metadata: Metadata = {
  title: 'Privacy Policy', description, alternates: { canonical: '/privacy' },
  openGraph: { title: 'Privacy Policy | GoodSale', description, url: absoluteUrl('/privacy'), siteName: 'GoodSale', type: 'website' },
  twitter: { card: 'summary', title: 'Privacy Policy | GoodSale', description },
};
const SECTIONS: { heading: string; body: string[] }[] = [
  { heading: '1. What we collect', body: [
    'Account data: your name, username, email address, phone number, chosen role, and password (stored only as a secure hash by our authentication provider).',
    'Transaction data: orders, escrow records, payment references, wallet balances, withdrawal bank details, and delivery addresses and PINs needed to complete a trade.',
    'Identity data: when you apply for verification, the government ID, selfie, and business documents you upload. These are used only to review your application.',
    'Usage and device data: approximate location you provide for delivery and dispatch, device and log information, and cookies needed to keep you signed in and to keep the service secure.',
  ]},
  { heading: '2. How we use it', body: [
    'To operate the marketplace: create your account, show listings, process escrow payments, release funds after PIN confirmation, coordinate GoodDispatch delivery, and let buyers and sellers communicate.',
    'To keep people safe: verify identities, detect and prevent fraud, investigate disputes, and enforce our Terms of Service.',
    'To support you: respond to help requests and send essential service messages such as order, escrow, dispute, and payout notifications.',
  ]},
  { heading: '3. Sharing', body: [
    'We share only what is needed to run a transaction. Payments are processed by Paystack, which handles your card and bank details under its own PCI-compliant systems — GoodSale never sees your full card number or ATM PIN.',
    'Delivery details are shared with the courier assigned to your order. Public listing and seller profile information is visible to other users. We do not sell your personal data to third-party marketers.',
    'We may disclose information where required by law, to enforce our Terms, or to protect the rights and safety of our users.',
  ]},
  { heading: '4. Storage and security', body: [
    'Data is stored with our cloud/Postgres infrastructure provider. Access is governed by row-level security, and server-side actions that move money require service-level credentials that are never exposed to the browser.',
    'Identity documents are held in a private storage bucket. We retain records for as long as your account is active and for a reasonable period afterward where required for legal, tax, and dispute purposes.',
  ]},
  { heading: '5. Your rights', body: [
    'You can review and update your profile and business details in Settings at any time. You can request a copy of your data, ask us to correct it, or ask us to delete your account from the Account Controls section.',
    'Where you ask us to delete data we are legally required to keep (for example completed transaction and tax records), we will delete everything else and explain what we must retain.',
  ]},
  { heading: '6. Cookies', body: [
    'We use strictly necessary cookies to authenticate you and to protect the service. We do not use advertising cookies. You can clear cookies in your browser, but you will be signed out.',
  ]},
  { heading: '7. Children', body: [
    'GoodSale is for adults aged 18 and over. We do not knowingly collect data from children. If we learn that we have, we will delete it.',
  ]},
  { heading: '8. Changes', body: [
    'We may update this policy as the service evolves. Material changes will be surfaced in the app. This policy is governed by the laws of the Federal Republic of Nigeria.',
  ]},
];
const SECTION_ICONS=[Database,Eye,Share2,LockKeyhole,UserRound,Cookie,Baby,Scale];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-ink-50 text-ink-800 dark:bg-ink-950 dark:text-ink-200">
      <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 lg:px-8 lg:py-12">
        <Link href="/" className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white/80 px-3.5 py-2 text-xs font-semibold text-ink-600 transition-colors hover:border-jade-400 hover:text-jade-700 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300 dark:hover:text-jade-300">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to GoodSale
        </Link>
        <header className="gs-hero-panel relative mt-6 overflow-hidden rounded-[2rem] px-6 py-9 text-white shadow-[0_28px_70px_-42px_rgba(6,37,31,0.75)] sm:px-9 sm:py-12">
          <div className="relative z-10 max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/85 backdrop-blur"><ShieldCheck className="h-3.5 w-3.5 text-gold-300" /> Privacy &amp; data</span>
            <h1 className="mt-5 font-display text-3xl font-extrabold tracking-[-0.04em] sm:text-5xl">Your privacy, clearly explained.</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-white/75 sm:text-base">What GoodSale collects, why it is needed to run a protected marketplace, who receives it, and the choices available to you.</p>
            <p className="mt-6 text-xs font-medium text-white/60">Policy version · 11 November 2026</p>
          </div>
        </header>
        <section className="gs-receipt mt-6 grid gap-0 overflow-hidden rounded-2xl sm:grid-cols-3">
          {[
            { label: 'Data sales', value: 'Not sold', detail: 'Personal data is not sold to marketers.' },
            { label: 'Cookies', value: 'Essential only', detail: 'For sign-in and service security.' },
            { label: 'Identity files', value: 'Private storage', detail: 'Verification documents are kept private.' },
          ].map((item,index)=>(
            <div key={item.label} className={`px-5 py-5 ${index?'border-t border-ink-200 sm:border-l sm:border-t-0 dark:border-ink-800':''}`}>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-500 dark:text-ink-400">{item.label}</p>
              <p className="mt-2 font-display text-xl font-bold tracking-tight text-ink-900 dark:text-white">{item.value}</p>
              <p className="mt-1 text-xs leading-5 text-ink-500 dark:text-ink-400">{item.detail}</p>
            </div>
          ))}
        </section>
        <div className="mt-8 grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start">
          <aside className="rounded-2xl border border-ink-200 bg-white p-5 dark:border-ink-800 dark:bg-ink-900 lg:sticky lg:top-28">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-400">In this policy</p>
            <nav aria-label="Privacy policy sections" className="mt-3 space-y-1">
              {SECTIONS.map((section,index)=>(
                <a key={section.heading} href={`#privacy-${index+1}`} className="block rounded-xl px-3 py-2 text-xs font-semibold text-ink-600 transition-colors hover:bg-ink-50 hover:text-jade-700 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-jade-300">
                  {section.heading.replace(/^\d+\. /,'')}
                </a>
              ))}
            </nav>
          </aside>
          <div className="space-y-4">
            {SECTIONS.map((section,index)=>{
              const Icon=SECTION_ICONS[index]||FileText;
              return <section id={`privacy-${index+1}`} key={section.heading} className="scroll-mt-28 rounded-2xl border border-ink-200/80 bg-white p-5 sm:p-7 dark:border-ink-800 dark:bg-ink-900">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-jade-500/10 text-jade-700 dark:text-jade-300"><Icon className="h-5 w-5" aria-hidden="true" /></span>
                  <div className="min-w-0">
                    <h2 className="font-display text-lg font-bold tracking-tight text-ink-900 dark:text-white">{section.heading}</h2>
                    <div className="mt-3 space-y-3">{section.body.map((paragraph,i)=><p key={i} className="text-sm leading-7 text-ink-600 dark:text-ink-300">{paragraph}</p>)}</div>
                  </div>
                </div>
              </section>;
            })}
          </div>
        </div>
        <section className="mt-8 flex flex-col gap-4 rounded-[1.5rem] border border-ink-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between sm:p-7 dark:border-ink-800 dark:bg-ink-900">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-jade-700 dark:text-jade-300">Data requests</p>
            <h2 className="mt-1 font-display text-xl font-bold text-ink-900 dark:text-white">Need help with your information?</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-ink-500 dark:text-ink-400">Review your details in Settings or contact support about access, corrections or account deletion.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <a href="mailto:support@goodsale.ng" className="inline-flex items-center gap-2 rounded-xl bg-jade-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-jade-700"><Mail className="h-4 w-4" /> Contact support</a>
            <Link href="/terms" className="inline-flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 transition-colors hover:border-jade-400 dark:border-ink-700 dark:text-ink-200"><FileText className="h-4 w-4" /> Terms</Link>
          </div>
        </section>
        <p className="mt-6 text-center text-[11px] text-ink-400">GoodSale · Privacy Policy · Updated 11 November 2026</p>
      </div>
    </main>
  );
}

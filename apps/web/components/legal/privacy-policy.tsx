import { getTranslations } from 'next-intl/server'
import './legal.css'

const productName = 'Sentinello'
const productDomain = 'https://sentinello.org'
const lastUpdated = 'May 20, 2026'

export default async function PrivacyPolicy() {
    const t = await getTranslations('Legal')
    return (
        <div className="flex flex-col legal">
            <h1 className="text-3xl font-bold">{t('privacyTitle')}</h1>
            <p>{t('lastUpdated', { date: lastUpdated })}</p>
            <h2 className="text-2xl font-bold">Interpretation and Definitions</h2>
            <h3 className="text-xl font-bold">Interpretation</h3>
            <p>
                The words of which the initial letter is capitalized have meanings defined under the
                following conditions. The following definitions shall have the same meaning
                regardless of whether they appear in singular or in plural.
            </p>
            <h3 className="text-xl font-bold">Definitions</h3>
            <p>For the purposes of this Privacy Policy:</p>
            <ul>
                <li>
                    <p>
                        <strong>Affiliate</strong> means an entity that controls, is controlled by
                        or is under common control with a party, where &quot;control&quot; means
                        ownership of 50% or more of the shares, equity interest or other securities
                        entitled to vote for election of directors or other managing authority.
                    </p>
                </li>
                <li>
                    <p>
                        <strong>Company</strong> (referred to as either &quot;the Company&quot;,
                        &quot;We&quot;, &quot;Us&quot; or &quot;Our&quot; in this Agreement) refers
                        to Walk of Code LLC, 4030 Wake Forest Rd, Ste 349.
                    </p>
                </li>
                <li>
                    <p>
                        <strong>Country</strong> refers to: North Carolina, United States
                    </p>
                </li>
                <li>
                    <p>
                        <strong>Device</strong> means any device that can access the Service such as
                        a computer, a cellphone or a digital tablet.
                    </p>
                </li>
                <li>
                    <p>
                        <strong>Personal Data</strong> is any information that relates to an
                        identified or identifiable individual.
                    </p>
                </li>
                <li>
                    <p>
                        <strong>Service</strong> refers to the Website.
                    </p>
                </li>
                <li>
                    <p>
                        <strong>Website</strong> refers to {productName}, accessible from{' '}
                        <a href={productDomain} rel="external nofollow noopener" target="_blank">
                            {productDomain}
                        </a>
                    </p>
                </li>
                <li>
                    <p>
                        <strong>You</strong> means the individual accessing or using the Service, or
                        the company, or other legal entity on behalf of which such individual is
                        accessing or using the Service, as applicable.
                    </p>
                </li>
            </ul>
            <h2 className="text-2xl font-bold">Data We Collect</h2>
            <p>
                Sentinello runs entirely on your own infrastructure and collects no personal
                data. It does not read the source code of your projects; it discovers projects
                solely by locating <code>package.json</code> files to build a list of npm
                projects, and runs the standard <code>npm audit</code> against them. Your code
                is never uploaded anywhere, and no large language model or other artificial
                intelligence is involved in any part of the process.
            </p>
            <p>
                The only network requests Sentinello makes are the ones listed in the
                &quot;What Sentinello sends out&quot; section of the{' '}
                <a href="/about">About page</a>: advisory lookups to the npm registry during a
                scan, and an optional update check against the GitHub Releases API (which can be
                disabled). No telemetry, analytics, or usage data leaves your machine.
            </p>
            <h2 className="text-2xl font-bold">Children's Privacy</h2>
            <p>
                Our Service does not address anyone under the age of 13. We do not knowingly collect
                personally identifiable information from anyone under the age of 13. If You are a
                parent or guardian and You are aware that Your child has provided Us with Personal
                Data, please contact Us. If We become aware that We have collected Personal Data
                from anyone under the age of 13 without verification of parental consent, We take
                steps to remove that information from Our servers.
            </p>
            <p>
                If We need to rely on consent as a legal basis for processing Your information and
                Your country requires consent from a parent, We may require Your parent's consent
                before We collect and use that information.
            </p>
            <h2 className="text-2xl font-bold">Links to Other Websites</h2>
            <p>
                Our Service may contain links to other websites that are not operated by Us. If You
                click on a third party link, You will be directed to that third party's site. We
                strongly advise You to review the Privacy Policy of every site You visit.
            </p>
            <p>
                We have no control over and assume no responsibility for the content, privacy
                policies or practices of any third party sites or services.
            </p>
            <h2 className="text-2xl font-bold">Changes to this Privacy Policy</h2>
            <p>
                We may update Our Privacy Policy from time to time. We will notify You of any
                changes by posting the new Privacy Policy on this page.
            </p>
            <p>
                We will let You know prior to the change becoming effective and update the
                &quot;Last updated&quot; date at the top of this Privacy Policy.
            </p>
            <p>
                You are advised to review this Privacy Policy periodically for any changes. Changes
                to this Privacy Policy are effective when they are posted on this page.
            </p>
            <h2 className="text-2xl font-bold">Contact Us</h2>
            <p>If you have any questions about this Privacy Policy, You can contact us:</p>
            <ul>
                <li>
                    <p>
                        By email: <a href="mailto:info@sentinello.org">info@sentinello.org</a>
                    </p>
                </li>
                <li>
                    <p>
                        By visiting this page on our website:{' '}
                        <a
                            href={`${productDomain}/contact`}
                            rel="external nofollow noopener"
                            target="_blank"
                        >
                            {productDomain}/contact
                        </a>
                    </p>
                </li>
            </ul>
        </div>
    )
}

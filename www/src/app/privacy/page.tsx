import { Metadata } from "next";
import LegalLayout from "@/app/components/legal-layout";

export const metadata: Metadata = {
  title: "Privacy Policy - Loft",
};

export default function PrivacyPolicy() {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="March 11, 2026">
      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">What We Collect</h2>
        <p>
          When you sign up for Loft, we collect your email address via Google OAuth.
          When you connect your Google Drive, we access your Google Drive file contents
          and metadata (titles, modification dates) for the purpose of indexing.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">How We Use It</h2>
        <p>
          We generate vector embeddings from your document text to enable semantic search.
          We store text chunks alongside these embeddings so results can be returned to you.
          Your data is only used to provide the search service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Third Parties</h2>
        <p>
          We use the OpenAI API to generate text embeddings. Only document text is sent
          to OpenAI; no personally identifiable information (such as your email) is
          included. We use Turso for database hosting.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Data Storage &amp; Security</h2>
        <p>
          Your data is stored in a cloud-hosted database and scoped to your user account.
          We take reasonable measures to protect your data, but no system is 100% secure.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Data Deletion</h2>
        <p>
          You can disconnect your Google Drive at any time from the dashboard, which stops
          further syncing. To request full deletion of your account and all associated data,
          contact us at{" "}
          <a href="mailto:support@getloft.app" className="text-blue-600 hover:underline">
            support@getloft.app
          </a>.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Google API Compliance</h2>
        <p>
          Loft&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Contact</h2>
        <p>
          For questions about this policy, contact us at{" "}
          <a href="mailto:support@getloft.app" className="text-blue-600 hover:underline">
            support@getloft.app
          </a>.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Changes</h2>
        <p>
          We may update this Privacy Policy from time to time. Changes will be reflected
          by updating the &quot;Last updated&quot; date at the top of this page.
        </p>
      </section>
    </LegalLayout>
  );
}

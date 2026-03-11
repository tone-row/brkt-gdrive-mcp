import { Metadata } from "next";
import LegalLayout from "@/app/components/legal-layout";

export const metadata: Metadata = {
  title: "Terms of Use - Loft",
};

export default function TermsOfUse() {
  return (
    <LegalLayout title="Terms of Use" lastUpdated="March 11, 2026">
      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Acceptance</h2>
        <p>
          By accessing or using Loft, you agree to be bound by these Terms of Use.
          If you do not agree, do not use the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Service Description</h2>
        <p>
          Loft indexes your Google Drive documents (Docs, Sheets, PDFs, and more) to
          enable semantic search. It also functions as an MCP server, allowing AI tools
          like Claude and Cursor to search your documents.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">User Accounts</h2>
        <p>
          You must provide accurate information when creating an account. You are
          responsible for maintaining the security of your account credentials and
          API keys.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Acceptable Use</h2>
        <p>
          You agree not to misuse the service, attempt unauthorized access, or use
          Loft in violation of any applicable laws or Google&apos;s Terms of Service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Google Drive Access</h2>
        <p>
          Loft requests read-only access to your Google Drive. You can revoke this
          access at any time from your dashboard or from your Google account settings.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Intellectual Property</h2>
        <p>
          You retain full ownership of your content. Loft does not claim any rights
          over documents or data you provide through the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Limitation of Liability</h2>
        <p>
          Loft is provided &quot;as is&quot; without warranties of any kind, express or implied.
          We are not liable for any damages arising from your use of the service,
          including but not limited to data loss or service interruptions.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Termination</h2>
        <p>
          Either party may terminate use of the service at any time. You can delete
          your account by contacting{" "}
          <a href="mailto:support@getloft.app" className="text-blue-600 hover:underline">
            support@getloft.app
          </a>
          . We reserve the right to suspend or terminate accounts that violate these terms.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Changes</h2>
        <p>
          We may update these Terms of Use from time to time. Changes will be reflected
          by updating the &quot;Last updated&quot; date at the top of this page.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Contact</h2>
        <p>
          For questions about these terms, contact us at{" "}
          <a href="mailto:support@getloft.app" className="text-blue-600 hover:underline">
            support@getloft.app
          </a>.
        </p>
      </section>
    </LegalLayout>
  );
}

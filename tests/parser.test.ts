import { describe, it, expect } from "vitest";
import { parseInteracEmail } from "../src/parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toArrayBuffer(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Fixtures — Direct Interac emails
// ---------------------------------------------------------------------------

// English autodeposit: reference embedded both as URL param and labelled line.
// reply_to_email comes from Reply-To header.
const FIXTURE_EN_AUTODEPOSIT = `From: donotreply@payments.interac.ca
To: payments@example.com
Subject: You received an e-Transfer
Reply-To: john.doe@gmail.com
Message-ID: <abc123@payments.interac.ca>
Content-Type: text/plain

John Doe sent you $150.00.
This Interac e-Transfer has been automatically deposited into your account.
Reference Number: ETR-2024-XK9P2L
Message: ORDER-1001
Amount: $150.00`;

// English pending (security question): no auto-deposit language
const FIXTURE_EN_PENDING = `From: donotreply@payments.interac.ca
To: payments@example.com
Subject: Someone sent you an e-Transfer
Reply-To: jane.smith@hotmail.com
Message-ID: <def456@payments.interac.ca>
Content-Type: text/plain

Jane Smith sent you $75.50.
To deposit your money, answer the security question.
Reference Number: ETR-2024-QW3RT5
Message: ORDER-1002
Amount: $75.50`;

// French autodeposit
const FIXTURE_FR_AUTODEPOSIT = `From: donotreply@payments.interac.ca
To: payments@example.com
Subject: Vous avez reçu un virement Interac
Reply-To: pierre.leblanc@videotron.ca
Message-ID: <ghi789@payments.interac.ca>
Content-Type: text/plain

Pierre Leblanc vous a envoyé 200,00 $.
Ce virement Interac a été déposé automatiquement dans votre compte.
Numéro de référence: ETR-2024-FR5TY7
Message: ORDER-1003
Montant: 200,00 $`;

// Email where reference is only in a URL query param (no labelled text line)
const FIXTURE_EN_REFERENCE_URL_ONLY = `From: donotreply@payments.interac.ca
To: payments@example.com
Subject: You received an e-Transfer
Reply-To: alice@example.com
Message-ID: <url123@payments.interac.ca>
Content-Type: text/plain

Alice Example sent you $50.00.
This Interac e-Transfer has been automatically deposited into your account.

To view details visit: https://etransfer.interac.ca/deposit?referenceNumber=IREF-7890ABCD&lang=en

Amount: $50.00`;

// Email with no reference and no user message (should return null gracefully)
const FIXTURE_EN_MINIMAL = `From: donotreply@payments.interac.ca
To: payments@example.com
Subject: You received an e-Transfer
Message-ID: <min001@payments.interac.ca>
Content-Type: text/plain

Bob Smith sent you $25.00.
This Interac e-Transfer has been automatically deposited into your account.
Amount: $25.00`;

// ---------------------------------------------------------------------------
// Fixtures — Forwarded emails
// ---------------------------------------------------------------------------

// Gmail forwarding style: "---------- Forwarded message ---------"
const FIXTURE_GMAIL_FORWARDED = `From: forwarder@gmail.com
To: payments@example.com
Subject: Fwd: You received an e-Transfer
Message-ID: <fwd001@gmail.com>
Content-Type: text/plain

FYI, forwarding this for processing.

---------- Forwarded message ---------
From: donotreply@payments.interac.ca
Date: Mon, 1 Jan 2024 10:00:00 -0500
Subject: You received an e-Transfer
To: original@gmail.com
Reply-To: carol@example.com

Carol Smith sent you $300.00.
This Interac e-Transfer has been automatically deposited into your account.
Reference Number: ETR-2024-GMAIL99
Message: ORDER-GMAIL-1
Amount: $300.00`;

// Apple Mail forwarding style: "Begin forwarded message:"
const FIXTURE_APPLE_FORWARDED = `From: iphone-user@icloud.com
To: payments@example.com
Subject: Fwd: You received an e-Transfer
Message-ID: <fwd002@icloud.com>
Content-Type: text/plain

Forwarding for record keeping.

Begin forwarded message:

From: donotreply@payments.interac.ca
Date: Tue, 2 Jan 2024 14:00:00 -0500
Subject: You received an e-Transfer
To: iphone-user@icloud.com
Reply-To: dave@example.com

Dave Jones sent you $450.00.
This Interac e-Transfer has been automatically deposited into your account.
Reference Number: ETR-2024-APPLE77
Message: ORDER-APPLE-2
Amount: $450.00`;

// Gmail forwarded with quote-prefix lines (">" style)
const FIXTURE_GMAIL_QUOTED_FORWARDED = `From: someone@gmail.com
To: payments@example.com
Subject: Fwd: Interac
Message-ID: <fwd003@gmail.com>
Content-Type: text/plain

---------- Forwarded message ---------
> From: donotreply@payments.interac.ca
> Reply-To: eve@example.com
>
> Eve Martin sent you $120.00.
> This Interac e-Transfer has been automatically deposited into your account.
> Reference Number: ETR-2024-QUOTE55
> Message: ORDER-QUOTE-3
> Amount: $120.00`;

// ---------------------------------------------------------------------------
// Tests — Direct emails
// ---------------------------------------------------------------------------

describe("parseInteracEmail", () => {
  describe("direct emails", () => {
    it("parses English autodeposit email", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_EN_AUTODEPOSIT),
        "payments@example.com",
      );

      expect(result.amountCents).toBe(15000);
      expect(result.isAutoDeposit).toBe(true);
      expect(result.language).toBe("en");
      expect(result.reference).toBe("ETR-2024-XK9P2L");
      expect(result.userMessage).toContain("ORDER-1001");
      expect(result.replyToEmail).toBe("john.doe@gmail.com");
      expect(result.fromName).toBe("John Doe");
      expect(result.toEmail).toBe("payments@example.com");
      expect(result.currency).toBe("CAD");
      expect(result.senderVerified).toBe(false);
      expect(result.isForwarded).toBe(false);
    });

    it("parses English pending (security question) email", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_EN_PENDING),
        "payments@example.com",
      );

      expect(result.amountCents).toBe(7550);
      expect(result.isAutoDeposit).toBe(false);
      expect(result.language).toBe("en");
      expect(result.reference).toBe("ETR-2024-QW3RT5");
      expect(result.userMessage).toContain("ORDER-1002");
      expect(result.replyToEmail).toBe("jane.smith@hotmail.com");
      expect(result.fromName).toBe("Jane Smith");
      expect(result.isForwarded).toBe(false);
    });

    it("parses French autodeposit email", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_FR_AUTODEPOSIT),
        "payments@example.com",
      );

      expect(result.amountCents).toBe(20000);
      expect(result.isAutoDeposit).toBe(true);
      expect(result.language).toBe("fr");
      expect(result.reference).toBe("ETR-2024-FR5TY7");
      expect(result.userMessage).toContain("ORDER-1003");
      expect(result.replyToEmail).toBe("pierre.leblanc@videotron.ca");
      expect(result.fromName).toBe("Pierre Leblanc");
      expect(result.currency).toBe("CAD");
      expect(result.isForwarded).toBe(false);
    });

    it("extracts reference from URL query parameter when no labelled line present", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_EN_REFERENCE_URL_ONLY),
        "payments@example.com",
      );

      expect(result.reference).toBe("IREF-7890ABCD");
      expect(result.amountCents).toBe(5000);
      expect(result.isAutoDeposit).toBe(true);
      expect(result.isForwarded).toBe(false);
    });

    it("returns null for reference and userMessage when absent (no crash)", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_EN_MINIMAL),
        "payments@example.com",
      );

      expect(result.reference).toBeNull();
      expect(result.userMessage).toBeNull();
      expect(result.replyToEmail).toBeNull();
      expect(result.amountCents).toBe(2500);
      expect(result.isAutoDeposit).toBe(true);
      expect(result.fromName).toBe("Bob Smith");
      expect(result.isForwarded).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Tests — Forwarded emails
  // -------------------------------------------------------------------------

  describe("forwarded emails", () => {
    it("detects and unwraps Gmail-style forwarded email", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_GMAIL_FORWARDED),
        "payments@example.com",
      );

      expect(result.isForwarded).toBe(true);
      expect(result.amountCents).toBe(30000);
      expect(result.isAutoDeposit).toBe(true);
      expect(result.reference).toBe("ETR-2024-GMAIL99");
      expect(result.userMessage).toContain("ORDER-GMAIL-1");
      expect(result.fromName).toBe("Carol Smith");
      // reply_to_email should come from the embedded header in the forwarded block
      expect(result.replyToEmail).toBe("carol@example.com");
    });

    it("detects and unwraps Apple Mail-style forwarded email", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_APPLE_FORWARDED),
        "payments@example.com",
      );

      expect(result.isForwarded).toBe(true);
      expect(result.amountCents).toBe(45000);
      expect(result.isAutoDeposit).toBe(true);
      expect(result.reference).toBe("ETR-2024-APPLE77");
      expect(result.userMessage).toContain("ORDER-APPLE-2");
      expect(result.fromName).toBe("Dave Jones");
      expect(result.replyToEmail).toBe("dave@example.com");
    });

    it("strips quote-prefix '>' lines in Gmail forwarded quoted style", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_GMAIL_QUOTED_FORWARDED),
        "payments@example.com",
      );

      expect(result.isForwarded).toBe(true);
      expect(result.amountCents).toBe(12000);
      expect(result.isAutoDeposit).toBe(true);
      expect(result.reference).toBe("ETR-2024-QUOTE55");
      expect(result.fromName).toBe("Eve Martin");
      expect(result.replyToEmail).toBe("eve@example.com");
    });
  });

  // -------------------------------------------------------------------------
  // Regression: is_forwarded field must be present in all parsed results
  // (missing column caused D1 INSERT exception in production — t_29650f14)
  // -------------------------------------------------------------------------
  describe("regression: is_forwarded always present", () => {
    it("direct email has isForwarded=false", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_EN_AUTODEPOSIT),
        "payments@example.com",
      );
      expect(result).toHaveProperty("isForwarded");
      expect(result.isForwarded).toBe(false);
    });

    it("Gmail-forwarded email has isForwarded=true", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_GMAIL_FORWARDED),
        "payments@example.com",
      );
      expect(result).toHaveProperty("isForwarded");
      expect(result.isForwarded).toBe(true);
    });

    it("Apple-forwarded email has isForwarded=true", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_APPLE_FORWARDED),
        "payments@example.com",
      );
      expect(result).toHaveProperty("isForwarded");
      expect(result.isForwarded).toBe(true);
    });

    it("parsed result keys match D1 INSERT column list", async () => {
      const result = await parseInteracEmail(
        toArrayBuffer(FIXTURE_EN_AUTODEPOSIT),
        "payments@example.com",
      );
      // These are exactly the fields referenced in the INSERT in index.ts.
      // If any field is missing from ParsedInteracEmail the TypeScript build
      // would already catch it, but this test guards against runtime undefined values
      // being silently coerced to NULL when the column does not exist in the schema.
      const requiredFields = [
        "messageId",
        "fromName",
        "toEmail",
        "replyToEmail",
        "amountCents",
        "currency",
        "reference",
        "isAutoDeposit",
        "userMessage",
        "language",
        "subject",
        "bodyRaw",
        "isForwarded",   // <-- was missing from schema, caused the 5x exception
        "senderVerified",
      ];
      for (const field of requiredFields) {
        expect(result, `field '${field}' must exist on parsed result`).toHaveProperty(field);
      }
    });
  });
});

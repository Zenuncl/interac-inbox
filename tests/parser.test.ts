import { describe, it, expect } from "vitest";
import { parseInteracEmail } from "../src/parser";

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

function toArrayBuffer(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

describe("parseInteracEmail", () => {
  it("parses English autodeposit email", async () => {
    const result = await parseInteracEmail(
      toArrayBuffer(FIXTURE_EN_AUTODEPOSIT),
      "payments@example.com",
    );

    expect(result.amountCents).toBe(15000);
    expect(result.isAutoDeposit).toBe(true);
    expect(result.language).toBe("en");
    expect(result.reference).toContain("ETR-2024-XK9P2L");
    expect(result.userMessage).toContain("ORDER-1001");
    expect(result.replyToEmail).toBe("john.doe@gmail.com");
    expect(result.fromName).toBe("John Doe");
    expect(result.toEmail).toBe("payments@example.com");
    expect(result.currency).toBe("CAD");
    expect(result.senderVerified).toBe(false);
  });

  it("parses English pending (security question) email", async () => {
    const result = await parseInteracEmail(
      toArrayBuffer(FIXTURE_EN_PENDING),
      "payments@example.com",
    );

    expect(result.amountCents).toBe(7550);
    expect(result.isAutoDeposit).toBe(false);
    expect(result.language).toBe("en");
    expect(result.reference).toContain("ETR-2024-QW3RT5");
    expect(result.userMessage).toContain("ORDER-1002");
    expect(result.replyToEmail).toBe("jane.smith@hotmail.com");
    expect(result.fromName).toBe("Jane Smith");
  });

  it("parses French autodeposit email", async () => {
    const result = await parseInteracEmail(
      toArrayBuffer(FIXTURE_FR_AUTODEPOSIT),
      "payments@example.com",
    );

    expect(result.amountCents).toBe(20000);
    expect(result.isAutoDeposit).toBe(true);
    expect(result.language).toBe("fr");
    expect(result.reference).toContain("ETR-2024-FR5TY7");
    expect(result.userMessage).toContain("ORDER-1003");
    expect(result.replyToEmail).toBe("pierre.leblanc@videotron.ca");
    expect(result.fromName).toBe("Pierre Leblanc");
    expect(result.currency).toBe("CAD");
  });
});

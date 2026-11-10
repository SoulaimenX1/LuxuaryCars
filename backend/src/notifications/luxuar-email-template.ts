/**
 * LUXUAR Transactional Email Template Generator
 *
 * Ultra-professional, executive HTML email layout matching the official LUXUAR
 * brand identity, with support for an embedded vehicle photograph inside the
 * reservation details card.
 *
 * Uses table-based layout and inline CSS for compatibility across Gmail,
 * Outlook, Apple Mail, and mobile clients.
 */

export function escapeHtml(str: string): string {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export interface LuxuarEmailRow {
    label: string;
    value: string;
    isStatus?: boolean;
}

export interface LuxuarEmailOptions {
    /** Small gold uppercase label at the top of the body, e.g. "RESERVATION UPDATE" */
    kicker?: string;
    /** Main bold heading, e.g. "Your reservation has been cancelled." */
    heading: string;
    /** Customer display name for "Dear <customerName>," */
    customerName: string;
    /** Introductory paragraph(s) below the greeting */
    introMessage: string;
    /** Kicker inside the beige details box, e.g. "RESERVATION DETAILS" */
    detailsTitle?: string;
    /** Vehicle name displayed prominently inside the details box, e.g. "Mercedes-AMG ONE" */
    vehicleName?: string;
    /** Vehicle image URL or CID URI (e.g. "cid:vehicle-photo@luxuar.hu" or full URL) */
    vehiclePhotoUrl?: string | null;
    /** Key-value rows inside the details card */
    rows?: LuxuarEmailRow[];
    /** Closing paragraph before the CTA button */
    postMessage?: string;
    /** Primary gold CTA button */
    ctaButton?: {
        label: string;
        url: string;
    };
    /** Sign-off text (defaults to "Kind regards, The LUXUAR Team") */
    signoff?: string;
    /** Copyright year (defaults to current year) */
    year?: number;
}

export function renderLuxuarEmailHtml(options: LuxuarEmailOptions): string {
    const currentYear = options.year ?? new Date().getFullYear();
    const signoffText = options.signoff || 'Kind regards, The LUXUAR Team';

    const hasDetailsBox =
        options.detailsTitle ||
        options.vehicleName ||
        options.vehiclePhotoUrl ||
        (options.rows && options.rows.length > 0);

    const rowsHtml =
        options.rows && options.rows.length > 0
            ? `
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
                  ${options.rows
                      .map(
                          (row) => `
                  <tr>
                    <td style="padding: 7px 0; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #6E675F; vertical-align: top;">
                      ${escapeHtml(row.label)}
                    </td>
                    <td align="right" style="padding: 7px 0; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700; color: ${row.isStatus ? '#9E7A45' : '#1A1918'}; text-align: right; vertical-align: top;">
                      ${escapeHtml(row.value)}
                    </td>
                  </tr>`,
                      )
                      .join('')}
                </table>`
            : '';

    const vehiclePhotoHtml = options.vehiclePhotoUrl
        ? `
                <div style="margin: 14px 0 18px 0; border-radius: 4px; overflow: hidden; background-color: #EFECE6; border: 1px solid #E5DFD5;">
                  <img src="${escapeHtml(options.vehiclePhotoUrl)}" alt="${escapeHtml(options.vehicleName || 'Reserved Vehicle')}" width="500" style="width: 100%; max-width: 500px; max-height: 260px; height: auto; object-fit: cover; display: block; border: 0; outline: none; text-decoration: none;" />
                </div>`
        : '';

    const detailsBoxHtml = hasDetailsBox
        ? `
          <!-- RESERVATION DETAILS CARD -->
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8F6F2; border: 1px solid #EDE8DE; border-collapse: collapse; margin: 0 0 24px 0;">
            <tr>
              <td style="padding: 22px 24px;">
                ${
                    options.detailsTitle
                        ? `<div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 700; color: #9E7A45; letter-spacing: 0.8px; text-transform: uppercase; margin: 0 0 10px 0;">${escapeHtml(options.detailsTitle)}</div>`
                        : ''
                }
                ${
                    options.vehicleName
                        ? `<div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 19px; font-weight: 600; color: #1A1918; margin: 0 0 ${options.vehiclePhotoUrl ? '12px' : '16px'} 0; letter-spacing: -0.2px;">${escapeHtml(options.vehicleName)}</div>`
                        : ''
                }
                ${vehiclePhotoHtml}
                ${
                    (options.detailsTitle || options.vehicleName || options.vehiclePhotoUrl) &&
                    options.rows &&
                    options.rows.length > 0
                        ? `<div style="border-top: 1px solid #E5DFD5; margin: 0 0 12px 0; line-height: 1px; font-size: 1px;">&nbsp;</div>`
                        : ''
                }
                ${rowsHtml}
              </td>
            </tr>
          </table>`
        : '';


    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(options.heading)}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td, h1, p, a, div, span { font-family: 'Segoe UI', Arial, sans-serif !important; }
  </style>
  <![endif]-->
  <style type="text/css">
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #F4F1EA; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; }
      .content-padding { padding: 24px 20px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #F4F1EA; -webkit-font-smoothing: antialiased;">
  <center style="width: 100%; background-color: #F4F1EA; padding: 24px 0;">
    <table role="presentation" class="email-container" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; width: 100%; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E6E1D6; border-collapse: collapse;">
      
      <!-- HEADER -->
      <tr>
        <td align="center" style="background-color: #161513; padding: 34px 24px 30px 24px; text-align: center;">
          <div style="font-family: Georgia, 'Times New Roman', serif; font-size: 27px; font-weight: 700; color: #C5A880; letter-spacing: 8px; text-transform: uppercase; margin: 0 0 8px 0; line-height: 1.1;">
            L U X U A R
          </div>
          <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 10px; font-weight: 600; color: #A39282; letter-spacing: 3.5px; text-transform: uppercase; margin: 0; line-height: 1.2;">
            P R E M I U M C A R R E N T A L
          </div>
        </td>
      </tr>

      <!-- MAIN BODY -->
      <tr>
        <td class="content-padding" style="padding: 36px 32px 32px 32px; background-color: #FFFFFF;">
          ${
              options.kicker
                  ? `<div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 700; color: #9E7A45; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 14px 0;">${escapeHtml(options.kicker)}</div>`
                  : ''
          }
          
          <h1 style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 700; color: #1C1917; margin: 0 0 22px 0; line-height: 1.3; letter-spacing: -0.3px;">
            ${escapeHtml(options.heading)}
          </h1>

          <p style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 15px; color: #4A4542; line-height: 1.6; margin: 0 0 16px 0;">
            Dear ${escapeHtml(options.customerName)},
          </p>

          <p style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #4A4542; line-height: 1.65; margin: 0 0 24px 0;">
            ${escapeHtml(options.introMessage).replace(/\n/g, '<br>')}
          </p>

          ${detailsBoxHtml}

          ${
              options.postMessage
                  ? `<p style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #4A4542; line-height: 1.65; margin: 0 0 22px 0;">${escapeHtml(options.postMessage).replace(/\n/g, '<br>')}</p>`
                  : ''
          }

          ${
              options.ctaButton
                  ? `
          <!-- FULL-WIDTH GOLD CTA BUTTON -->
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 24px 0; border-collapse: collapse;">
            <tr>
              <td align="center" bgcolor="#B89352" style="background-color: #B89352; border-radius: 2px;">
                <a href="${escapeHtml(options.ctaButton.url)}" target="_blank" style="display: block; padding: 15px 20px; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700; color: #1F1911; text-align: center; text-decoration: none; letter-spacing: 0.8px; text-transform: uppercase;">
                  ${escapeHtml(options.ctaButton.label)}
                </a>
              </td>
            </tr>
          </table>`
                  : ''
          }

          <p style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; color: #5C554E; line-height: 1.6; margin: 0;">
            ${escapeHtml(signoffText)}
          </p>
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td align="center" style="background-color: #161513; padding: 32px 24px 28px 24px; text-align: center;">
          <div style="font-family: Georgia, 'Times New Roman', serif; font-size: 18px; font-weight: 700; color: #C5A880; letter-spacing: 5px; text-transform: uppercase; margin: 0 0 8px 0;">
            L U X U A R
          </div>
          <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 12px; color: #A59D92; margin: 0 0 20px 0;">
            Excellence in every journey.
          </div>
          <div style="border-top: 1px solid #2E2A25; margin: 0 0 18px 0; line-height: 1px; font-size: 1px;">&nbsp;</div>
          <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #8A8175; margin: 0 0 6px 0;">
            Premium Car Rental · Customer Support
          </div>
          <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #8A8175; margin: 0 0 10px 0;">
            Concierge Desk: <a href="mailto:luxurycarsrentcars@gmail.com" style="color: #C5A880; text-decoration: none;">luxurycarsrentcars@gmail.com</a>
          </div>
          <div style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #6E675F; margin: 0;">
            © ${currentYear} LUXUAR
          </div>
        </td>
      </tr>

    </table>
  </center>
</body>
</html>`;
}

/**
 * Plain-text alternative generator for LUXUAR transactional emails.
 * Guarantees accessibility and clean rendering on terminals, wearables,
 * and text-only email clients.
 */
export function renderLuxuarEmailText(options: LuxuarEmailOptions): string {
    const currentYear = options.year ?? new Date().getFullYear();
    const signoffText = options.signoff || 'Kind regards, The LUXUAR Team';
    const lines: string[] = [];

    lines.push('LUXUAR · PRESTIGE FLEET');
    lines.push('==================================================');
    lines.push('');

    if (options.kicker) {
        lines.push(`[${options.kicker.toUpperCase()}]`);
    }
    lines.push(options.heading);
    lines.push('');
    lines.push(`Dear ${options.customerName},`);
    lines.push('');
    lines.push(options.introMessage.trim());
    lines.push('');

    const hasDetails =
        options.detailsTitle ||
        options.vehicleName ||
        (options.rows && options.rows.length > 0);

    if (hasDetails) {
        lines.push('--------------------------------------------------');
        if (options.detailsTitle) {
            lines.push(options.detailsTitle.toUpperCase());
        }
        if (options.vehicleName) {
            lines.push(`Vehicle: ${options.vehicleName}`);
        }
        if (options.rows && options.rows.length > 0) {
            for (const row of options.rows) {
                lines.push(`• ${row.label}: ${row.value}`);
            }
        }
        lines.push('--------------------------------------------------');
        lines.push('');
    }

    if (options.postMessage) {
        lines.push(options.postMessage.trim());
        lines.push('');
    }

    if (options.ctaButton) {
        lines.push(`${options.ctaButton.label.toUpperCase()}:`);
        lines.push(options.ctaButton.url);
        lines.push('');
    }

    lines.push(signoffText);
    lines.push('');
    lines.push('==================================================');
    lines.push('LUXUAR Premium Car Rental');
    lines.push('Excellence in every journey.');
    lines.push('Customer Support: luxurycarsrentcars@gmail.com');
    lines.push(`© ${currentYear} LUXUAR. All rights reserved.`);

    return lines.join('\n');
}

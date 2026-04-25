// src/services/sendGridService.js

import sgMail from '@sendgrid/mail';
import { Resend } from 'resend';

// Set your SendGrid API Key from environment variables
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const resendSenderEmail = process.env.RESEND_SENDER_EMAIL || 'no-reply@gradmanagers.com';

/**
 * Sends a personalized welcome email to a new user.
 * @param {string} toEmail - The recipient's email address.
 * @param {string} firstName - The recipient's first name.
 */
export const sendWelcomeEmail = async (toEmail, firstName) => {
    // You should use a verified sender email in your SendGrid account
    const senderEmail = process.env.SENDGRID_SENDER_EMAIL || 'no-reply@gradmanagers.com';

    const msg = {
        to: toEmail,
        from: senderEmail, // Must be a verified sender in SendGrid
        subject: `Welcome to Grad Manager, ${firstName}! 🎉`,
        html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2 style="color: #007bff;">Hello ${firstName},</h2>
                <p>Welcome to **Grad Manager**! Your account has been successfully created. We are excited to help you manage your graduate school applications with ease and precision.</p>
                <p>To fully secure and activate your account, please remember to click the verification link we sent to your email address.</p>
                
                <h3 style="color: #007bff;">What's next?</h3>
                <ul style="list-style-type: disc; margin-left: 20px;">
                    <li>**Verify Your Email:** Check your inbox for the separate verification link (it might be in your spam folder!).</li>
                    <li>**Log In:** Once verified, log in and start adding your target programs.</li>
                    <li>**Explore Features:** Check out our Application Tracker, AI tools, and Mentor Connections.</li>
                </ul>

                <p style="margin-top: 25px;">Happy applying!</p>
                <p>— The Grad Manager Team</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 0.8em; color: #999;">If you did not sign up for Grad Manager, please ignore this email.</p>
            </div>
        `,
    };

    try {
        await sgMail.send(msg);
        console.log(`[SendGrid] Welcome email successfully sent to ${toEmail}`);
    } catch (error) {
        console.error(`[SendGrid Error] Failed to send welcome email to ${toEmail}:`, error.response?.body || error.message);
        throw new Error("Failed to send email via SendGrid.");
    }
};

// You can add other email functions here (e.g., resetPasswordEmail)

/**
 * Sends a generic email to a single recipient.
 * Includes comprehensive anti-spam headers and proper email authentication.
 * @param {string} toEmail
 * @param {string} subject
 * @param {string} html
 */
export const sendGeneralEmail = async (toEmail, subject, html) => {
    const senderEmail = process.env.SENDGRID_SENDER_EMAIL || 'no-reply@gradmanagers.com';
    const senderName = 'Grad Managers'; // Add sender name for better deliverability
    const replyToEmail = process.env.SENDGRID_REPLY_TO || 'support@gradmanagers.com';

    // Wrap HTML with professional email structure with enhanced formatting and styling
    const wrappedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${subject}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f5f5;
        }
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .email-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px 20px;
            text-align: center;
        }
        .email-header h1 {
            font-size: 24px;
            font-weight: 600;
            margin: 0;
            letter-spacing: -0.5px;
        }
        .email-content {
            padding: 40px 30px;
            line-height: 1.8;
        }
        .email-content h2 {
            color: #667eea;
            font-size: 20px;
            margin-top: 25px;
            margin-bottom: 15px;
            font-weight: 600;
        }
        .email-content h3 {
            color: #555;
            font-size: 16px;
            margin-top: 20px;
            margin-bottom: 12px;
            font-weight: 600;
        }
        .email-content p {
            margin-bottom: 15px;
            color: #555;
            font-size: 14px;
        }
        .email-content ul, .email-content ol {
            margin-left: 20px;
            margin-bottom: 15px;
        }
        .email-content li {
            margin-bottom: 8px;
            color: #555;
            font-size: 14px;
        }
        .email-content blockquote {
            border-left: 4px solid #667eea;
            padding-left: 15px;
            margin: 20px 0;
            color: #666;
            font-style: italic;
        }
        .cta-button {
            display: inline-block;
            background-color: #667eea;
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
            font-size: 14px;
            transition: background-color 0.3s ease;
        }
        .cta-button:hover {
            background-color: #5568d3;
        }
        .highlight-box {
            background-color: #f0f4ff;
            border-left: 4px solid #667eea;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .highlight-box p {
            margin: 0;
            color: #333;
        }
        .divider {
            border: none;
            border-top: 2px solid #eee;
            margin: 30px 0;
        }
        .email-footer {
            background-color: #f9f9f9;
            border-top: 1px solid #eee;
            padding: 25px 30px;
            font-size: 12px;
            color: #999;
            text-align: center;
            line-height: 1.6;
        }
        .email-footer p {
            margin: 5px 0;
            font-size: 12px;
        }
        .email-footer a {
            color: #667eea;
            text-decoration: none;
        }
        .email-footer a:hover {
            text-decoration: underline;
        }
        .spacer {
            height: 20px;
        }
        code {
            background-color: #f5f5f5;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            color: #d73a49;
        }
        .text-center {
            text-align: center;
        }
        .text-muted {
            color: #999;
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="email-header">
            <h1>Grad Managers</h1>
        </div>
        <div class="email-content">
            ${html}
        </div>
        <div class="email-footer">
            <p><strong>&copy; 2025 Grad Managers. All rights reserved.</strong></p>
            <div class="spacer"></div>
            <p>
                <a href="https://gradmanagers.com">Visit our website</a> | 
                <a href="https://gradmanagers.com/about">About Us</a> | 
                <a href="https://gradmanagers.com/contact">Contact</a> | 
                <a href="https://gradmanagers.com/unsubscribe">Unsubscribe</a>
            </p>
            <p class="text-muted">This is a broadcast email from Grad Managers. If you don't wish to receive these emails, you can unsubscribe at any time.</p>
        </div>
    </div>
</body>
</html>
    `;

    const msg = {
        to: toEmail,
        from: `${senderName} <${senderEmail}>`, // Proper format: "Name <email>"
        replyTo: replyToEmail, // Set a reply-to address
        subject,
        html: wrappedHtml,
        // Categories help with tracking in SendGrid dashboard
        categories: ['broadcast'],
        // Comprehensive anti-spam headers for better deliverability
        headers: {
            // Authentication and priority headers
            'X-Mailer': 'SendGrid/GradManagers',
            'X-Priority': '3 (Normal)',
            'X-MSMail-Priority': 'Normal',
            
            // MIME version and format
            'MIME-Version': '1.0',
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Transfer-Encoding': '8bit',
            
            // List management (helps with spam filters)
            'List-Unsubscribe': '<https://gradmanagers.com/unsubscribe>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'List-Help': '<https://gradmanagers.com/help>',
            'List-Owner': `<mailto:${replyToEmail}>`,
            
            // Feedback loop and monitoring
            'X-Feedback-ID': `broadcast:gradmanagers:${Date.now()}`,
            'X-Report-Abuse': `Please report abuse to ${replyToEmail}`,
            
            // Custom tracking headers (SendGrid respects these)
            'X-Mailer-Version': '1.0',
            'X-Entity-Ref-ID': `broadcast-${Date.now()}`,
            
            // ARC (Authenticated Received Chain) support
            'X-Authentication': 'SendGrid',
        },
        mailSettings: {
            // Enable sandbox mode to prevent sending during testing (if ENV set)
            sandboxMode: {
                enable: process.env.SENDGRID_SANDBOX_MODE === 'true',
            },
            // Enable footer (adds unsubscribe link to HTML)
            footer: {
                enable: false, // We're managing our own footer
            },
            // Bypass list management to ensure emails are delivered
            bypassListManagement: {
                enable: false, // Respect user preferences
            },
            // SpamCheck enabled to get spam score feedback
            spamCheck: {
                enable: true, // This helps identify potential spam issues
                threshold: 5, // Allow emails with spam score below 5
            },
        },
        trackingSettings: {
            // Track opens and clicks
            clickTracking: {
                enable: true,
                enableText: true, // Track plain text links
            },
            openTracking: {
                enable: true,
                substitutionTag: '%open-track%',
            },
            // Subscription tracking
            subscriptionTracking: {
                enable: true,
                text: 'Manage your email preferences <% click here %>',
                html: '<a href="<% click here %>">Manage email preferences</a>',
            },
        },
    };

    const shouldFallbackToResend = (err) => {
        const status = err?.response?.statusCode || err?.response?.status || err?.code || null;
        const errors = err?.response?.body?.errors || [];
        const hasInvalidEmail = errors.some((e) => {
            const msg = String(e?.message || '').toLowerCase();
            return msg.includes('invalid') && (msg.includes('email') || msg.includes('address'));
        });

        if (hasInvalidEmail) return false;
        if (status && status >= 400 && status < 500 && status !== 429) return false;
        return true;
    };

    try {
        const response = await sgMail.send(msg);
        console.log(`[SendGrid] General email sent to ${toEmail} - Message ID: ${response[0].headers['x-message-id']}`);
    } catch (error) {
        console.error(`[SendGrid Error] Failed to send general email to ${toEmail}:`, error.response?.body || error.message);

        if (!resend || !shouldFallbackToResend(error)) {
            throw new Error('Failed to send general email via SendGrid.');
        }

        try {
            const resendResponse = await resend.emails.send({
                from: `Grad Managers <${resendSenderEmail}>`,
                to: toEmail,
                subject,
                html: wrappedHtml,
            });
            console.log(`[Resend] General email sent to ${toEmail} - ID: ${resendResponse?.id || 'unknown'}`);
        } catch (resendError) {
            console.error(`[Resend Error] Failed to send general email to ${toEmail}:`, resendError?.message || resendError);
            throw new Error('Failed to send general email via SendGrid and Resend.');
        }
    }
};

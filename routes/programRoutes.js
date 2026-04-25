// routes/programRoutes.js
import express from "express";
import Airtable from "airtable";
// 🚨 CHANGE: Using a default import and naming it 'protect'
import protect from "../middleware/auth.js"; 
// Note: You may need to change the path to '../middleware/auth.js' if you kept the original file name.

const router = express.Router();

// Initialize Airtable connection (separate tokens supported)
const usClient = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const nonUsClient = new Airtable({
    apiKey: process.env.AIRTABLE_NON_US_API_KEY || process.env.AIRTABLE_API_KEY,
});

const usBase = usClient.base(process.env.AIRTABLE_BASE_ID);
const nonUsBaseId = process.env.AIRTABLE_NON_US_BASE_ID || process.env.AIRTABLE_BASE_ID;
const nonUsBase = nonUsClient.base(nonUsBaseId);

const usTableName = process.env.AIRTABLE_US_TABLE || "Updated Programs";
const nonUsTableName = process.env.AIRTABLE_NON_US_TABLE || "Non-US Programs";

const getTable = (region) => {
    if (region === "non-us") return nonUsBase(nonUsTableName);
    return usBase(usTableName);
};

const getRegionConfig = (region) => {
    if (region === "non-us") {
        return {
            label: "non-us",
            baseId: nonUsBaseId,
            table: nonUsTableName,
            usingNonUsToken: Boolean(process.env.AIRTABLE_NON_US_API_KEY),
        };
    }
    return {
        label: "us",
        baseId: process.env.AIRTABLE_BASE_ID,
        table: usTableName,
        usingNonUsToken: false,
    };
};

// 🧠 Simple in-memory cache (Logic unchanged)
let cache = {
    us: { timestamp: 0, data: null },
    "non-us": { timestamp: 0, data: null },
};

// Helper function to fetch and format Airtable data (Logic unchanged)
async function fetchAirtableData({ search, funding, sortField, region }) {
    let filterFormula = "";
    const conditions = [];

    if (search) {
        const cleanSearch = search.replace(/"/g, '\\"');
        conditions.push(
            `OR(
                FIND(LOWER("${cleanSearch}"), LOWER({University})),
                FIND(LOWER("${cleanSearch}"), LOWER({Department}))
            )`
        );
    }

    if (funding) {
        conditions.push(`{Funding} = "${funding}"`);
    }

    if (conditions.length > 0) {
        filterFormula = `AND(${conditions.join(",")})`;
    }

    const sortOption =
        sortField === "funding"
            ? [{ field: "Funding", direction: "asc" }]
            : [{ field: "Application Deadline", direction: "desc" }];

    const records = [];

    const airtableSelectOptions = {
        view: "Grid view",
        sort: sortOption,
    };

    if (filterFormula && filterFormula.length > 0) {
        airtableSelectOptions.filterByFormula = filterFormula;
    }

    console.log("Airtable Query Options:", { 
        filterByFormula: airtableSelectOptions.filterByFormula || 'none',
        sort: sortOption[0].field 
    });

    const table = getTable(region);
    const regionConfig = getRegionConfig(region);
    console.log("Airtable Target:", {
        region: regionConfig.label,
        baseId: regionConfig.baseId,
        table: regionConfig.table,
        tokenSource: regionConfig.usingNonUsToken ? "AIRTABLE_NON_US_API_KEY" : "AIRTABLE_API_KEY",
    });

    await table
        .select(airtableSelectOptions)
        .eachPage((pageRecords, fetchNextPage) => {
            records.push(...pageRecords);
            fetchNextPage();
        });

    return records.map((record) => ({
        id: record.id,
        university: record.fields["University"],
        department: record.fields["Department"],
        professors: record.fields["Professors"] || null,
        funding: record.fields["Funding"] || "N/A",
        fundingAmount: record.fields["Funding Amount"] || "N/A",
        deadline: record.fields["Application Deadline"] || "N/A",
        greWaiver: record.fields["GRE Waiver"] || "N/A",
        ieltsWaiver: record.fields["IELTS Waiver"] || "N/A",
        appFeeWaiver: record.fields["Application Fee Waiver"] || "N/A",
        requiredDocs: Array.isArray(record.fields["Required Documents"]) 
            ? record.fields["Required Documents"] 
            : (record.fields["Required Documents"] ? [record.fields["Required Documents"]] : []),
        appLink: record.fields["Application Link"] || null,
    }));
}

// ✅ GET programs with pagination, search, funding, sort, and cache
// 🚨 Usage of the imported 'protect' middleware is correct
router.get("/", protect, async (req, res) => {
    try {
        const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const { search, funding, sort = "deadline", page: pageStr = '1', limit: limitStr = '10', region = "us" } = req.query;
        const normalizedRegion = region === "non-us" ? "non-us" : "us";
        console.log("Programs Request:", { requestId, region: normalizedRegion, search: Boolean(search), funding: Boolean(funding) });
        
        const page = parseInt(pageStr, 10);
        const limit = parseInt(limitStr, 10);

        // ⏳ Determine if we can use the cache
        const now = Date.now();
        const cacheTTL = 5 * 60 * 1000; 
        
        let records;

        const regionCache = cache[normalizedRegion];

        if (
            regionCache.data &&
            now - regionCache.timestamp < cacheTTL &&
            !search &&
            !funding
        ) {
            records = regionCache.data;
            console.log("⚡ Serving programs from cache...", { requestId });
        } else {
            console.log("♻️ Fetching programs from Airtable...", { requestId });
            const data = await fetchAirtableData({
                search,
                funding,
                sortField: sort,
                region: normalizedRegion,
            });
            
            if (!search && !funding) {
                cache[normalizedRegion] = { data, timestamp: now };
            }
            records = data;
        }

        // Manual pagination
        const totalCount = records.length;
        const totalPages = Math.ceil(totalCount / limit);
        const start = (page - 1) * limit;
        const end = start + limit;
        const paginated = records.slice(start, end);

        res.json({
            currentPage: page,
            pageSize: limit,
            totalPages,
            totalCount,
            data: paginated,
        });
    } catch (error) {
        console.error("Airtable API error:", error);
        res.status(500).json({ message: "Failed to fetch programs." });
    }
});

// ✅ Simple health check for Airtable connectivity (no secrets)
router.get("/health", protect, async (req, res) => {
    try {
        const usConfig = getRegionConfig("us");
        const nonUsConfig = getRegionConfig("non-us");

        const results = { us: null, "non-us": null };

        await Promise.all([
            usBase(usConfig.table)
                .select({ maxRecords: 1 })
                .firstPage()
                .then(() => {
                    results.us = { ok: true, baseId: usConfig.baseId, table: usConfig.table };
                })
                .catch((err) => {
                    results.us = { ok: false, baseId: usConfig.baseId, table: usConfig.table, error: err?.error || err?.message || "unknown" };
                }),
            nonUsBase(nonUsConfig.table)
                .select({ maxRecords: 1 })
                .firstPage()
                .then(() => {
                    results["non-us"] = { ok: true, baseId: nonUsConfig.baseId, table: nonUsConfig.table };
                })
                .catch((err) => {
                    results["non-us"] = {
                        ok: false,
                        baseId: nonUsConfig.baseId,
                        table: nonUsConfig.table,
                        error: err?.error || err?.message || "unknown",
                    };
                }),
        ]);

        res.json({ ok: true, results });
    } catch (error) {
        res.status(500).json({ ok: false, message: "Health check failed." });
    }
});

export default router;

import axios from "axios";

export async function scrapeDAAD() {
  console.log("🌍 Scraping DAAD graduate programs (API)...");

  try {
    const url =
      "https://www2.daad.de/deutschland/studienangebote/international-programmes/en/json/?degree=2";
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const programs = data?.result?.map((item) => ({
      title: item.title,
      university: item.university,
      city: item.city,
      degree: item.degree,
      tuition: item.tuition_fee,
      language: item.languages.join(", "),
      deadline: item.application_deadline,
      link: `https://www2.daad.de${item.link}`,
    })) || [];

    console.log(`✅ DAAD: Found ${programs.length} programs`);
    return programs;
  } catch (error) {
    console.error("❌ DAAD scrape error:", error.message);
    return [];
  }
}

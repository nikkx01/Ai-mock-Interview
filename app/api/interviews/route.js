import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "@/utils/db";
import { MockInterview } from "@/utils/schema";
import { createChatSession } from "@/utils/GeminiAIModal";
import { rateLimit } from "@/utils/rateLimit";
import { v4 as uuidv4 } from "uuid";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const interviewModels = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

async function generateInterviewQuestions(prompt, maxAttempts = 2) {
  let lastError;

  for (const modelName of interviewModels) {
    const session = createChatSession(modelName);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await session.sendMessage(prompt);
      } catch (error) {
        lastError = error;
        const isTemporaryFailure = error?.status === 429 || error?.status === 503;

        if (!isTemporaryFailure) {
          throw error;
        }

        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
  }

  throw lastError;
}

// POST /api/interviews — generate questions via Gemini and save interview
export async function POST(request) {
  try {
    const { userId } = await auth();
    const user = await currentUser();
    if (!userId || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 5 new interviews per minute per user
    const rl = rateLimit(`create-interview:${userId}`, { limit: 5, windowMs: 60_000 });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many requests. Please wait before creating another interview." },
        { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { jobPosition, jobDesc, jobExperience } = body;

    // Validate
    if (
      typeof jobPosition !== "string" ||
      typeof jobDesc !== "string" ||
      !["string", "number"].includes(typeof jobExperience)
    ) {
      return NextResponse.json({ error: "Invalid field types" }, { status: 400 });
    }

    const experienceInput = String(jobExperience).trim();
    if (!jobPosition.trim() || !jobDesc.trim() || !experienceInput) {
      return NextResponse.json({ error: "All fields are required" }, { status: 400 });
    }

    const expNum = Number(experienceInput);
    if (!Number.isInteger(expNum) || expNum < 0 || expNum > 50) {
      return NextResponse.json(
        { error: "Years of experience must be a whole number between 0 and 50" },
        { status: 400 }
      );
    }

    // Sanitize
    const sanitize = (str) =>
      str.replace(/[<>{}]/g, "").trim().substring(0, 500);
    const position = sanitize(jobPosition);
    const description = sanitize(jobDesc);
    const experience = String(expNum);

    if (!position || !description) {
      return NextResponse.json(
        { error: "Job position and description must contain valid text" },
        { status: 400 }
      );
    }

    // Generate questions with Gemini
    const prompt = `Generate 5 interview questions and answers for:
Job Position: ${position}
Job Description: ${description}
Years of Experience: ${experience}

Please provide a valid JSON array with this exact format:
[
  {
    "Question": "Your interview question here?",
    "Answer": "Your detailed answer here."
  }
]

Keep questions professional and relevant to the job requirements.`;

    const aiResult = await generateInterviewQuestions(prompt);
    const responseText = aiResult.response.text();

    // Clean and validate JSON
    const cleanedResponse = responseText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .replace(/^\s*[\r\n]/gm, "")
      .trim();

    let parsedQuestions;
    try {
      parsedQuestions = JSON.parse(cleanedResponse);
    } catch {
      return NextResponse.json(
        { error: "Failed to parse AI response. Please try again." },
        { status: 502 }
      );
    }

    if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
      return NextResponse.json(
        { error: "Invalid AI response format. Please try again." },
        { status: 502 }
      );
    }

    const normalizedQuestions = [];
    for (const item of parsedQuestions) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.Question !== "string" ||
        typeof item.Answer !== "string" ||
        !item.Question.trim() ||
        !item.Answer.trim()
      ) {
        return NextResponse.json(
          { error: "Invalid question format from AI. Please try again." },
          { status: 502 }
        );
      }

      normalizedQuestions.push({
        Question: item.Question.trim(),
        Answer: item.Answer.trim(),
      });
    }

    // Save to DB
    const userEmail = user.primaryEmailAddress?.emailAddress ?? "";
    const mockId = uuidv4();
    const createdAt = new Date().toISOString().split("T")[0];

    await db.insert(MockInterview).values({
      mockId,
      jsonMockResp: JSON.stringify(normalizedQuestions),
      jobPosition: position,
      jobDesc: description,
      jobExperience: experience,
      createdBy: userEmail,
      createdAt,
    });

    return NextResponse.json({ mockId }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/interviews]", error);

    if (error?.status === 429 || error?.status === 503) {
      return NextResponse.json(
        { error: "The AI service is busy right now. Please try again in a moment." },
        { status: 503, headers: { "Retry-After": "10" } }
      );
    }

    return NextResponse.json(
      { error: "Failed to create interview. Please try again." },
      { status: 500 }
    );
  }
}

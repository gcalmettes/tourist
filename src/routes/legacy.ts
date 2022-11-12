import * as fs from "fs";
import * as os from "os";

import {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import playwright from "playwright";

import {
  LegacyVisitRequestType,
  LegacyVisitReplyType,
  LegacyVisitRequest,
  LegacyVisitReply,
} from "../schemas/legacy";

export default (
  fastify: FastifyInstance,
  options: FastifyPluginOptions,
  done: (err?: Error | undefined) => void,
) => {
  fastify.post<{ Body: LegacyVisitRequestType; Reply: LegacyVisitReplyType }>(
    "/visit",
    {
      schema: { body: LegacyVisitRequest, response: { 200: LegacyVisitReply } },
      handler: getVisitHandler(fastify),
    },
  );

  done();
};

const getVisitHandler = (fastify: FastifyInstance) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { steps, cookies, record, screenshot, pdf } = <LegacyVisitRequestType>(
      request.body
    );

    if ([record, screenshot, pdf].filter(Boolean).length > 1) {
      reply.status(400).send({
        statusCode: 400,
        status: "failed",
        error: "Bad Request",
        message:
          "Exactly one option of [record, screenshot, pdf] can be used at a time",
      });
    }

    const browser = await playwright.chromium.launch();

    let context;
    if (record) {
      context = await browser.newContext({ recordVideo: { dir: os.tmpdir() } });
    } else {
      context = await browser.newContext();
    }

    if (cookies) {
      await context.addCookies(cookies);
    }

    const page = await context.newPage();

    for (const step of steps) {
      const actions = {
        preOpen: [] as string[],
        postOpen: [] as string[],
      };

      // split step actions into preOpen and postOpen
      // listeners such as page.on need to be registered before page.goto()
      if (step.actions) {
        actions.preOpen = step.actions.filter(action => action.startsWith("page.on"));
        actions.postOpen = step.actions.filter(action => !action.startsWith("page.on"));
      }

      for (const preOpenAction of actions.preOpen) {
        try {
          await (async () => eval(preOpenAction))();
        } catch (e) {
          fastify.log.error(e);
          return reply.status(400).send({
            statusCode: 400,
            status: "failed",
            message: `invalid action "${preOpenAction}"`,
          });
        }
      }

      await page.goto(step.url);

      for (const postOpenAction of actions.postOpen) {
        try {
          await (async () => eval(postOpenAction))();
          await page.waitForLoadState();
        } catch (e) {
          fastify.log.error(e);
          return reply.status(400).send({
            statusCode: 400,
            status: "failed",
            message: `invalid action "${postOpenAction}"`,
          });
        }
      }
    }

    if (screenshot) {
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      const file = screenshotBuffer.toString("base64");
      return reply.send({ status: "ok", screenshot: file });
    }

    if (pdf) {
      const pdfBuffer = await page.pdf();
      const file = pdfBuffer.toString("base64");
      return reply.send({ status: "ok", pdf: file });
    }

    // video is only accessible after context is closed, but required open for screenshot / pdf
    await context.close();
    await browser.close();

    if (record) {
      const video = await page.video();

      if (video) {
        const path = await video.path();
        const videoBuffer = fs.readFileSync(path);
        const file = videoBuffer.toString("base64");
        fs.unlinkSync(path);

        return reply.send({ status: "ok", video: file });
      }
    }

    return reply.send({ status: "ok" });
  };
};

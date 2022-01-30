import Fastify, { FastifyInstance } from "fastify";
import FastifySwagger from "fastify-swagger";

import { prismaPlugin, uvicPlugin } from "./plugin";

import { Static, Type } from "@sinclair/typebox";

import {
  KualiCourseCatalog,
  KualiCourseItem,
} from "@vikelabs/uvic-course-scraper/dist/types";
import fastifyRedis from "fastify-redis";

function subjectCodeExtractor(course: KualiCourseItem | KualiCourseCatalog): {
  subject: string;
  code: string;
} {
  return {
    subject: course.__catalogCourseId.slice(0, course.subjectCode.name.length),
    code: course.__catalogCourseId.slice(course.subjectCode.name.length),
  };
}

const User = Type.Object({
  name: Type.String(),
  mail: Type.Optional(Type.String({ format: "email" })),
  courses: Type.Array(Type.Object({ id: Type.String() }), {
    minItems: 1,
    maxItems: 10,
  }),
});
type UserType = Static<typeof User>;

// Create a Fastify server instance
const server: FastifyInstance = Fastify({
  logger: true,
  ignoreTrailingSlash: true,
});

// Register the UVic Scraper plugin
server.register(uvicPlugin);
// Register the Prisma plugin
// server.register(prismaPlugin);
// Register the Redis plugin
// server.register(fastifyRedis, {
//   host: "localhost",
// });
// Register the OpenAPI plugin
server.register(FastifySwagger, {
  routePrefix: "/documentation",
  swagger: {
    info: {
      title: "CourseUp Information",
      description: "Testing the Fastify swagger API",
      version: "0.1.0",
    },
    host: "localhost",
    schemes: ["http"],
    consumes: ["application/json"],
    produces: ["application/json"],
    definitions: {},
  },
  uiHooks: {
    onRequest: (request, reply, next) => {
      next();
    },
    preHandler: (request, reply, next) => {
      next();
    },
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
  exposeRoute: true,
});

server.get("/", async (request, reply) => {
  return { hello: "world" };
});

server.get(
  "/semester",
  {
    schema: {
      summary: "Get the list of available semesters",
    },
  },
  async (_request, _reply) => {
    return {
      terms: ["202109", "202201"],
    };
  }
);

const CoursesParams = Type.Object({
  term: Type.Optional(
    Type.Union([Type.Literal("202109"), Type.Literal("202110")])
  ),
});

const CoursesQuery = Type.Object({
  subject: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  // pagination
  page: Type.Optional(Type.Number({ min: 1 })),
  limit: Type.Optional(Type.Number({ min: 1 })),
});

const CoursesResponse = Type.Array(
  Type.Object({
    subject: Type.String(),
    code: Type.String(),
  }),
  {
    minItems: 1,
  }
);

server.get<{
  Params: Static<typeof CoursesParams>;
  Querystring: Static<typeof CoursesQuery>;
  Reply: Static<typeof CoursesResponse>;
}>(
  "/semester/:term/courses",
  {
    schema: {
      summary: "Get the list of courses for a given semester",
      tags: ["courses"],
      params: CoursesParams,
      querystring: CoursesQuery,
      response: {
        200: CoursesResponse,
      },
    },
  },
  async (request, _reply) => {
    const { uvic } = server;
    const { term } = request.params;
    server.log.info(`Fetching courses for term ${term}`);
    const courses = await uvic.getCourses(term);

    server.log.info(`Found ${courses.response.length} courses`);

    const c = courses.response.map((course) => subjectCodeExtractor(course));

    const { subject, code } = request.query;

    const limit = request.query.limit || 10;
    const page = request.query.page || 1;

    return c
      .filter((course) => !subject || subject === course.subject)
      .filter((course) => !code || code === course.code)
      .slice((page - 1) * limit, page * limit);
  }
);

const ClassParams = Type.Object({
  term: Type.Union([Type.Literal("202109"), Type.Literal("202110")]),
  subject: Type.String({ minLength: 2, maxLength: 4 }),
  code: Type.String({ minLength: 3, maxLength: 4 }),
});

server.get<{
  Params: Static<typeof ClassParams>;
}>(
  "/semester/:term/courses/:subject/:code",
  {
    schema: {
      params: ClassParams,
    },
  },
  async (request, reply) => {
    const { uvic } = server;
    const { term, subject, code } = request.params;
    const c = new uvic();

    const [details, sections] = await Promise.all([
      c.getCourseDetails(term, subject, code),
      uvic.getCourseSections(term, subject, code),
    ]);

    if (!details) {
      reply.code(404);
      return {
        error: "Course not found",
      };
    }

    return {
      ...details,
      sections: sections.response.map((section) => ({
        crn: section.crn,
        section: section.sectionCode,
        sectionType: section.sectionType,
      })),
    };
  }
);

const SectionParams = Type.Object({
  term: Type.Union([Type.Literal("202109"), Type.Literal("202110")]),
  subject: Type.String({ minLength: 2, maxLength: 4 }),
  code: Type.String({ minLength: 3, maxLength: 4 }),
  section: Type.String({ minLength: 1, maxLength: 4 }),
});

server.get<{
  Params: Static<typeof SectionParams>;
}>(
  "/semester/:term/courses/:subject/:code/:section",
  {},
  async (request, reply) => {
    const { uvic } = server;
    const { term, subject, code, section } = request.params;
    const c = new uvic();

    const details = await uvic.getCourseSections(term, subject, code);

    if (!details) {
      reply.code(404);
      return {
        error: "Course not found",
      };
    }

    return details.response.find((s) => s.sectionCode === section);
  }
);

server.ready((err) => {
  if (err) throw err;

  server.swagger();
});

server.listen(process.env.PORT || 3000, "0.0.0.0", (err, address) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
  // Server is now listening on ${address}
});

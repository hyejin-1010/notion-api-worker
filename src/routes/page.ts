import { fetchPageById, fetchBlocks } from "../api/notion";
import { parsePageId } from "../api/utils";
import { createResponse } from "../response";
import { getTableData } from "./table";
import { BlockType, CollectionType, HandlerRequest } from "../api/types";

// API 호출 횟수 제한 (Cloudflare 한도는 50)
const MAX_API_CALLS = 45; // 안전 마진으로 50 대신 45로 설정
let apiCallCount = 0;

// API 호출 래퍼 함수
async function limitedApiCall<T>(
  apiCallFn: () => Promise<T>,
  errorMessage: string
): Promise<T> {
  if (apiCallCount >= MAX_API_CALLS) {
    throw new Error("Too many API calls: " + errorMessage);
  }
  apiCallCount++;
  return await apiCallFn();
}

export async function pageRoute(req: HandlerRequest) {
  try {
    // API 호출 카운터 초기화
    apiCallCount = 0;

    const pageId = parsePageId(req.params.pageId);
    const page = await limitedApiCall(
      () => fetchPageById(pageId!, req.notionToken),
      "while fetching initial page"
    );

    const baseBlocks = page.recordMap.block;

    let allBlocks: { [id: string]: BlockType & { collection?: any } } = {
      ...baseBlocks,
    };

    // 최대 두 번 반복만 허용 (초기 블록 + 한 번의 추가 블록)
    const MAX_ITERATIONS = 2;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const allBlockKeys = Object.keys(allBlocks);

      // 각 반복에서 최대 20개의 블록만 처리
      const MAX_BLOCKS_PER_ITERATION = 20;

      const pendingBlocks = allBlockKeys
        .flatMap((blockId) => {
          const block = allBlocks[blockId];
          const content = block.value && block.value.content;

          if (
            !content ||
            (block.value.type === "page" && blockId !== pageId!)
          ) {
            // 요청한 페이지 외의 다른 페이지는 건너뜀
            return [];
          }

          return content.filter((id: string) => !allBlocks[id]);
        })
        .slice(0, MAX_BLOCKS_PER_ITERATION); // 최대 블록 수 제한

      if (!pendingBlocks.length) {
        break;
      }

      // 너무 많은 API 호출이 발생했는지 확인
      if (apiCallCount >= MAX_API_CALLS) {
        console.log(
          `Reached API call limit (${MAX_API_CALLS}). Stopping block fetching.`
        );
        break;
      }

      const newBlocks = await limitedApiCall(
        () =>
          fetchBlocks(pendingBlocks, req.notionToken).then(
            (res) => res.recordMap.block
          ),
        `while fetching blocks batch ${iteration + 1}`
      );

      allBlocks = { ...allBlocks, ...newBlocks };
    }

    const collection = page.recordMap.collection
      ? page.recordMap.collection[Object.keys(page.recordMap.collection)[0]]
      : null;

    const collectionView = page.recordMap.collection_view
      ? page.recordMap.collection_view[
          Object.keys(page.recordMap.collection_view)[0]
        ]
      : null;

    // 컬렉션 처리 (최대 1개 컬렉션으로 제한)
    if (collection && collectionView && apiCallCount < MAX_API_CALLS) {
      const allBlockKeys = Object.keys(allBlocks);

      // 컬렉션 뷰 블록 찾기
      const pendingCollections = allBlockKeys
        .flatMap((blockId) => {
          const block = allBlocks[blockId];
          return block.value && block.value.type === "collection_view"
            ? [block.value.id]
            : [];
        })
        .slice(0, 1); // 최대 1개 컬렉션만 처리

      if (pendingCollections.length > 0) {
        const b = pendingCollections[0];

        const collPage = await limitedApiCall(
          () => fetchPageById(b!, req.notionToken),
          "while fetching collection page"
        );

        if (
          collPage.recordMap.collection &&
          Object.keys(collPage.recordMap.collection).length > 0
        ) {
          const coll = Object.keys(collPage.recordMap.collection).map(
            (k) => collPage.recordMap.collection[k]
          )[0];

          const collView: {
            value: { id: CollectionType["value"]["id"] };
          } = Object.keys(collPage.recordMap.collection_view).map(
            (k) => collPage.recordMap.collection_view[k]
          )[0];

          if (apiCallCount < MAX_API_CALLS) {
            const { rows, schema } = await limitedApiCall(
              () =>
                getTableData(coll, collView.value.id, req.notionToken, true),
              "while fetching table data"
            );

            const viewIds = (allBlocks[b] as any).value.view_ids as string[];
            // 최대 1개 뷰로 제한
            const limitedViewIds = viewIds.slice(0, 1);

            allBlocks[b] = {
              ...allBlocks[b],
              collection: {
                title: coll.value.name,
                schema,
                types: limitedViewIds.map((id) => {
                  const col = collPage.recordMap.collection_view[id];
                  return col ? col.value : undefined;
                }),
                data: rows,
              },
            };
          }
        }
      }
    }

    return createResponse(allBlocks);
  } catch (error) {
    console.error("Error in pageRoute:", error);

    // 에러 메시지 및 상태 코드 결정
    const errorMessage =
      error.message || "An error occurred processing the page";
    let statusCode = 500;

    if (
      errorMessage.includes("Too many API calls") ||
      errorMessage.includes("Too many subrequests")
    ) {
      statusCode = 429; // Too Many Requests
    }

    return createResponse({ error: errorMessage }, {}, statusCode);
  }
}

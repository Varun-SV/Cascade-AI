// vitest.config.ts
import { defineConfig } from "file:///sessions/ecstatic-epic-mccarthy/mnt/Cascade-AI/node_modules/vitest/dist/config.js";
var __vite_injected_original_import_meta_url = "file:///sessions/ecstatic-epic-mccarthy/mnt/Cascade-AI/vitest.config.ts";
var vitest_config_default = defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/cli/**/*.tsx",
        "src/types.ts",
        // pure type file
        "src/constants.ts"
        // constants only
      ],
      thresholds: {
        branches: 70,
        functions: 75,
        lines: 80,
        statements: 80
      }
    }
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    alias: {
      // Allow importing .js extensions in tests (ESM compat)
      "#cascade": new URL("./src", __vite_injected_original_import_meta_url).pathname
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy9lY3N0YXRpYy1lcGljLW1jY2FydGh5L21udC9DYXNjYWRlLUFJXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvc2Vzc2lvbnMvZWNzdGF0aWMtZXBpYy1tY2NhcnRoeS9tbnQvQ2FzY2FkZS1BSS92aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9zZXNzaW9ucy9lY3N0YXRpYy1lcGljLW1jY2FydGh5L21udC9DYXNjYWRlLUFJL3ZpdGVzdC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcclxuXHJcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XHJcbiAgdGVzdDoge1xyXG4gICAgZ2xvYmFsczogdHJ1ZSxcclxuICAgIGVudmlyb25tZW50OiAnbm9kZScsXHJcbiAgICBpbmNsdWRlOiBbJ3NyYy8qKi8qLnRlc3QudHMnLCAnc3JjLyoqLyouc3BlYy50cyddLFxyXG4gICAgY292ZXJhZ2U6IHtcclxuICAgICAgcHJvdmlkZXI6ICd2OCcsXHJcbiAgICAgIHJlcG9ydGVyOiBbJ3RleHQnLCAnanNvbicsICdodG1sJ10sXHJcbiAgICAgIGluY2x1ZGU6IFsnc3JjLyoqLyoudHMnXSxcclxuICAgICAgZXhjbHVkZTogW1xyXG4gICAgICAgICdzcmMvKiovKi50ZXN0LnRzJyxcclxuICAgICAgICAnc3JjLyoqLyouc3BlYy50cycsXHJcbiAgICAgICAgJ3NyYy9jbGkvKiovKi50c3gnLFxyXG4gICAgICAgICdzcmMvdHlwZXMudHMnLCAgICAgICAgLy8gcHVyZSB0eXBlIGZpbGVcclxuICAgICAgICAnc3JjL2NvbnN0YW50cy50cycsICAgIC8vIGNvbnN0YW50cyBvbmx5XHJcbiAgICAgIF0sXHJcbiAgICAgIHRocmVzaG9sZHM6IHtcclxuICAgICAgICBicmFuY2hlczogNzAsXHJcbiAgICAgICAgZnVuY3Rpb25zOiA3NSxcclxuICAgICAgICBsaW5lczogODAsXHJcbiAgICAgICAgc3RhdGVtZW50czogODAsXHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gIH0sXHJcbiAgcmVzb2x2ZToge1xyXG4gICAgZXh0ZW5zaW9uczogWycudHMnLCAnLnRzeCcsICcuanMnLCAnLmpzeCddLFxyXG4gICAgYWxpYXM6IHtcclxuICAgICAgLy8gQWxsb3cgaW1wb3J0aW5nIC5qcyBleHRlbnNpb25zIGluIHRlc3RzIChFU00gY29tcGF0KVxyXG4gICAgICAnI2Nhc2NhZGUnOiBuZXcgVVJMKCcuL3NyYycsIGltcG9ydC5tZXRhLnVybCkucGF0aG5hbWUsXHJcbiAgICB9LFxyXG4gIH0sXHJcbn0pO1xyXG5cclxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFtVSxTQUFTLG9CQUFvQjtBQUF4SixJQUFNLDJDQUEyQztBQUV6UCxJQUFPLHdCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsSUFDSixTQUFTO0FBQUEsSUFDVCxhQUFhO0FBQUEsSUFDYixTQUFTLENBQUMsb0JBQW9CLGtCQUFrQjtBQUFBLElBQ2hELFVBQVU7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFVBQVUsQ0FBQyxRQUFRLFFBQVEsTUFBTTtBQUFBLE1BQ2pDLFNBQVMsQ0FBQyxhQUFhO0FBQUEsTUFDdkIsU0FBUztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQTtBQUFBLFFBQ0E7QUFBQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFlBQVk7QUFBQSxRQUNWLFVBQVU7QUFBQSxRQUNWLFdBQVc7QUFBQSxRQUNYLE9BQU87QUFBQSxRQUNQLFlBQVk7QUFBQSxNQUNkO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNQLFlBQVksQ0FBQyxPQUFPLFFBQVEsT0FBTyxNQUFNO0FBQUEsSUFDekMsT0FBTztBQUFBO0FBQUEsTUFFTCxZQUFZLElBQUksSUFBSSxTQUFTLHdDQUFlLEVBQUU7QUFBQSxJQUNoRDtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=

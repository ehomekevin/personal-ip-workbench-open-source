#import <Cocoa/Cocoa.h>
@interface Workbench : NSObject <NSApplicationDelegate>
@property(strong) NSTask *service;
@property BOOL quitting;
@end
@implementation Workbench
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSBundle *bundle = NSBundle.mainBundle;
    NSTask *task = [NSTask new];
    self.service = task;
    task.executableURL = [bundle.bundleURL URLByAppendingPathComponent:@"Contents/Helpers/node"];
    task.arguments = @[[bundle.resourcePath stringByAppendingPathComponent:@"runtime/launcher.mjs"], @"start"];
    NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
    [env removeObjectsForKeys:@[@"NODE_OPTIONS", @"NODE_PATH"]];
    task.environment = env;
    task.terminationHandler = ^(NSTask *ended) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.quitting) { [NSApp replyToApplicationShouldTerminate:YES]; return; }
            if (ended.terminationStatus) {
                NSAlert *alert = [NSAlert new];
                alert.messageText = @"创作有数启动或运行失败";
                alert.informativeText = @"请确认工作区可写，且工作台端口未被其他程序占用。";
                [alert runModal];
            }
            [NSApp terminate:nil];
        });
    };
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        [[NSAlert alertWithError:error] runModal];
        [NSApp terminate:nil];
    }
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (!self.service.running) return NSTerminateNow;
    if (!self.quitting) { self.quitting = YES; [self.service terminate]; }
    return NSTerminateLater;
}
@end
int main(void) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        Workbench * __attribute__((objc_precise_lifetime)) delegate = [Workbench new];
        app.delegate = delegate;
        NSMenu *bar = [NSMenu new];
        NSMenu *menu = [NSMenu new];
        NSMenuItem *item = [bar addItemWithTitle:@"" action:nil keyEquivalent:@""];
        item.submenu = menu;
        [menu addItemWithTitle:@"退出创作有数" action:@selector(terminate:) keyEquivalent:@"q"];
        app.mainMenu = bar;
        [app run];
        (void)delegate;
    }
    return 0;
}
